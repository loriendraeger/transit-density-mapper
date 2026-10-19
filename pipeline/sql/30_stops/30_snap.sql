-- Put every platform on the walk network: snap it to the nearest walkable edge of the
-- main component and split that edge there, so walking starts exactly at the stop.
-- net.edges = net.base_edges with those splits (rebuilt from scratch on every run).
--
-- Barrier roads snap by their side copies' offset geometry (geom_snap), so a platform
-- lands on its own side of the arterial. Crossing ways are skipped: a stop is never in
-- the middle of a crosswalk.

DELETE FROM net.vertices WHERE node < 0;   -- platform vertices from an earlier run

DROP TABLE IF EXISTS net.platform_snap;
CREATE TABLE net.platform_snap AS
SELECT pc.stop_id, pc.cluster_id, e.id AS edge_id, e.dist,
       -- Fraction along the edge's real geometry, measured on the copy we snapped to.
       ST_LineLocatePoint(e.geom_snap, s.geom) AS frac
FROM transit.platform_cluster pc
JOIN staging.stops s USING (stop_id)
CROSS JOIN LATERAL (
    SELECT b.id, b.geom_snap, ST_Distance(b.geom_snap, s.geom) AS dist
    FROM net.base_edges b
    LEFT JOIN staging.osm_edges o ON o.id = b.osm_edge
    WHERE b.main AND b.kind <> 'cross' AND NOT coalesce(o.is_crossing, false)
      AND ST_DWithin(b.geom_snap, s.geom, :snap_max_m)
    ORDER BY b.geom_snap <-> s.geom
    LIMIT 1
) e;

-- One vertex per distinct split point (two platforms can snap to the same spot).
-- Points at an edge's very end reuse its end vertex instead.
DROP TABLE IF EXISTS net.split_points;
CREATE TABLE net.split_points AS
SELECT edge_id, round(frac::numeric, 6)::float8 AS frac, array_agg(stop_id) AS stop_ids
FROM net.platform_snap
GROUP BY 1, 2;
ALTER TABLE net.split_points ADD COLUMN vertex int;

UPDATE net.split_points sp SET vertex = CASE WHEN sp.frac < 1e-6 THEN b.source ELSE b.target END
FROM net.base_edges b
WHERE b.id = sp.edge_id AND (sp.frac < 1e-6 OR sp.frac > 1 - 1e-6);

WITH ins AS (
    INSERT INTO net.vertices (node, sector, geom)
    SELECT -row_number() OVER (ORDER BY sp.edge_id, sp.frac), 0,
           ST_LineInterpolatePoint(b.geom, sp.frac)
    FROM net.split_points sp JOIN net.base_edges b ON b.id = sp.edge_id
    WHERE sp.vertex IS NULL
    ORDER BY sp.edge_id, sp.frac
    RETURNING id, node
)
UPDATE net.split_points sp SET vertex = ins.id
FROM (SELECT sp2.edge_id, sp2.frac,
             -row_number() OVER (ORDER BY sp2.edge_id, sp2.frac) AS node
      FROM net.split_points sp2 WHERE sp2.vertex IS NULL) k
JOIN ins ON ins.node = k.node
WHERE sp.edge_id = k.edge_id AND sp.frac = k.frac;

DROP TABLE IF EXISTS net.platform_vertex;
CREATE TABLE net.platform_vertex AS
SELECT ps.stop_id, ps.cluster_id, sp.vertex, ps.dist AS snap_dist
FROM net.platform_snap ps
JOIN net.split_points sp ON sp.edge_id = ps.edge_id
 AND sp.frac = round(ps.frac::numeric, 6)::float8;

-- net.edges: unsplit edges as they are, split edges as their pieces.
DROP TABLE IF EXISTS net.edges CASCADE;
CREATE TABLE net.edges AS
SELECT b.* FROM net.base_edges b
WHERE NOT EXISTS (SELECT 1 FROM net.split_points sp
                  WHERE sp.edge_id = b.id AND sp.frac > 1e-6 AND sp.frac < 1 - 1e-6);

WITH pts AS (
    SELECT edge_id, frac, vertex FROM net.split_points WHERE frac > 1e-6 AND frac < 1 - 1e-6
),
cuts AS (
    -- The edge's own ends plus every interior split point, in order along the edge.
    SELECT b.id AS edge_id, 0::float8 AS frac, b.source AS vertex FROM net.base_edges b
    WHERE b.id IN (SELECT edge_id FROM pts)
    UNION ALL
    SELECT b.id, 1, b.target FROM net.base_edges b WHERE b.id IN (SELECT edge_id FROM pts)
    UNION ALL
    SELECT edge_id, frac, vertex FROM pts
),
pieces AS (
    SELECT edge_id, frac AS f0, vertex AS v0,
           lead(frac) OVER w AS f1, lead(vertex) OVER w AS v1
    FROM cuts WINDOW w AS (PARTITION BY edge_id ORDER BY frac)
)
INSERT INTO net.edges
SELECT (SELECT max(id) FROM net.base_edges) + row_number() OVER (ORDER BY p.edge_id, p.f0),
       b.osm_edge, b.kind, p.v0, p.v1, b.cost * (p.f1 - p.f0), b.control,
       ST_LineSubstring(b.geom, p.f0, p.f1),
       ST_LineSubstring(b.geom_snap, p.f0, p.f1),
       b.main
FROM pieces p JOIN net.base_edges b ON b.id = p.edge_id
WHERE p.f1 IS NOT NULL;

ALTER TABLE net.edges ADD PRIMARY KEY (id);
CREATE INDEX ON net.edges (source);
CREATE INDEX ON net.edges (target);
CREATE INDEX ON net.edges USING gist (geom);
CREATE INDEX ON net.edges USING gist (geom_snap);
ANALYZE net.edges;
