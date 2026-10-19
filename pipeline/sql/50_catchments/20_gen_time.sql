-- Walk time from each merged stop to each generator point: along its edge from the
-- nearer reached end, plus the straight-line access walk from the edge to the point.
-- A POI with several access points takes its quickest.
DROP TABLE IF EXISTS catch.gen_time CASCADE;
CREATE TABLE catch.gen_time AS
WITH pt AS (
    SELECT et.cluster_id, g.kind, g.gen_id, g.category, g.value,
           least(et.ts + s.frac * e.cost, et.tt + (1 - s.frac) * e.cost)
               + s.dist / :walk_speed_mps AS t
    FROM gen.snap s
    JOIN gen.points g ON g.pid = s.pid
    JOIN net.edges e ON e.id = s.edge_id
    JOIN catch.edge_time et ON et.edge_id = s.edge_id
)
SELECT cluster_id, kind, gen_id, category, min(value) AS value, min(t) AS t
FROM pt
WHERE t <= :max_walk_min * 60
GROUP BY cluster_id, kind, gen_id, category;

-- Totals per merged stop and walk-time band (band b = (b-1, b] minutes; walk time 0
-- goes in band 1). The site sums bands up to the slider and applies the decay curve.
DROP TABLE IF EXISTS catch.bands CASCADE;
CREATE TABLE catch.bands AS
SELECT cluster_id,
       greatest(ceil(t / 60 / :band_min)::int, 1) AS band,
       CASE kind WHEN 'poi' THEN category ELSE kind END AS measure,
       sum(value) AS value,
       count(*) AS n
FROM catch.gen_time
GROUP BY 1, 2, 3;
