-- Overlap with neighboring stops (2026-10-21). A home two minutes from three stops is in
-- all three catchments; the score counts it in full at each (a "split" catchment,
-- sharing each place among the stops that reach it, predicted boardings worse: see
-- AGENTS.md). What a stop adds over its neighbors is shown separately:

-- Marginal value: what a stop adds over the next-best stop on its routes, at the default
-- walk limit and half-life. For each generator in reach: its decay weight here minus its
-- weight at the quickest other stop sharing a route (0 if none within the limit; never
-- below 0). Substitutes must share a route because a stop on another line isn't one
-- (merged stops hold both directions, so direction takes care of itself).
DROP TABLE IF EXISTS catch.marginal CASCADE;
CREATE TABLE catch.marginal AS
WITH rs AS (
    SELECT cluster_id, array_agg(DISTINCT route_id ORDER BY route_id) AS routes
    FROM transit.period_freq GROUP BY 1
),
g AS (
    SELECT g.cluster_id, g.kind, g.gen_id, g.category, g.value, g.t, rs.routes
    FROM catch.gen_time g JOIN rs USING (cluster_id)
    WHERE g.t <= :walk_min * 60
),
alt AS (
    SELECT a.cluster_id, a.kind, a.gen_id, min(b.t) AS t_alt
    FROM g a
    JOIN g b ON b.kind = a.kind AND b.gen_id = a.gen_id AND b.cluster_id <> a.cluster_id
            AND b.routes && a.routes
    GROUP BY 1, 2, 3
)
SELECT g.cluster_id,
       CASE g.kind WHEN 'poi' THEN g.category ELSE g.kind END AS measure,
       sum((g.value * power(0.5, g.t / 60.0 / :half_life_min))::numeric)::float8 AS full_value,
       sum((g.value * greatest(power(0.5, g.t / 60.0 / :half_life_min)
                               - coalesce(power(0.5, a.t_alt / 60.0 / :half_life_min), 0), 0))
           ::numeric)::float8 AS added,
       -- Plain counts (no decay): in reach, and those whose walk would grow by 2+ minutes
       -- (or who'd have no stop on these routes within the limit) without this stop.
       sum(g.value::numeric)::float8 AS in_reach,
       sum(g.value::numeric) FILTER (WHERE a.t_alt IS NULL OR a.t_alt - g.t >= 120)::float8
           AS far_without
FROM g
LEFT JOIN alt a USING (cluster_id, kind, gen_id)
GROUP BY 1, 2;
