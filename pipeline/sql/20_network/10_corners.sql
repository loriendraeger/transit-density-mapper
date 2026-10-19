-- The corner model: where barrier roads (arterials, see config/road_classes.csv) pass
-- through a node, the area around that node is cut into sectors ("corners") by the
-- barrier road's arms. Everything else that meets the node (sidewalks, side streets,
-- crossing ways, driveways) attaches to the corner it enters. Getting from one corner
-- to another means crossing an arm of the barrier road, which is only possible through
-- a crossing connector (20_graph.sql) whose cost depends on how the crossing is
-- controlled. Barrier roads themselves are walkable along each side, as two copies.
--
-- Azimuths are clockwise from north (ST_Azimuth). Looking outward from the node along
-- an arm, the sector clockwise from it is on its right.

-- Each edge has two ends; an end's azimuth points away from the node, measured a few
-- meters along the edge (the first vertex can be a hair away on curvy ways).
DROP TABLE IF EXISTS net.ends CASCADE;
CREATE TABLE net.ends AS
SELECT e.id AS edge_id, true AS at_source, e.source AS node, e.barrier,
       ST_Azimuth(ST_StartPoint(e.geom),
                  ST_LineInterpolatePoint(e.geom, least(3 / ST_Length(e.geom), 0.5))) AS az
FROM staging.osm_edges e
UNION ALL
SELECT e.id, false, e.target, e.barrier,
       ST_Azimuth(ST_EndPoint(e.geom),
                  ST_LineInterpolatePoint(e.geom, greatest(1 - 3 / ST_Length(e.geom), 0.5)))
FROM staging.osm_edges e;
CREATE INDEX ON net.ends (node);

-- Barrier arms at each node, numbered clockwise. Sector i lies between arm i and arm
-- i+1 (wrapping), so arm i has sector i on its right and sector i-1 on its left.
DROP TABLE IF EXISTS net.arms;
CREATE TABLE net.arms AS
SELECT edge_id, at_source, node, az,
       row_number() OVER w AS arm,
       count(*) OVER (PARTITION BY node) AS n_arms
FROM net.ends
WHERE barrier
WINDOW w AS (PARTITION BY node ORDER BY az, edge_id);
ALTER TABLE net.arms ADD COLUMN right_sector int, ADD COLUMN left_sector int;
UPDATE net.arms SET right_sector = arm,
                    left_sector = CASE WHEN arm = 1 THEN n_arms ELSE arm - 1 END;
CREATE INDEX ON net.arms (node);

-- Sector of every end at a barrier node: for a barrier arm, both of its sides (above);
-- for anything else, the sector its azimuth falls in, i.e. after the last arm at or
-- before it clockwise, wrapping to the last sector.
DROP TABLE IF EXISTS net.end_sector;
CREATE TABLE net.end_sector AS
SELECT e.edge_id, e.at_source, e.node,
       coalesce((SELECT max(a.arm) FROM net.arms a WHERE a.node = e.node AND a.az <= e.az),
                (SELECT max(a.n_arms) FROM net.arms a WHERE a.node = e.node)) AS sector
FROM net.ends e
WHERE NOT e.barrier
  AND EXISTS (SELECT 1 FROM net.arms a WHERE a.node = e.node);
CREATE INDEX ON net.end_sector (edge_id, at_source);

-- Vertices: one per ordinary node (sector 0) and one per corner of a barrier node.
DROP TABLE IF EXISTS net.vertices CASCADE;
CREATE TABLE net.vertices (
    id serial PRIMARY KEY, node bigint NOT NULL, sector int NOT NULL,
    geom geometry(Point, :crs), UNIQUE (node, sector));
INSERT INTO net.vertices (node, sector, geom)
SELECT n.node, s.sector, o.geom
FROM (SELECT DISTINCT node FROM net.ends) n
CROSS JOIN LATERAL (
    SELECT generate_series(1, max(a.n_arms)::int) AS sector FROM net.arms a WHERE a.node = n.node
    UNION ALL
    SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM net.arms a WHERE a.node = n.node)
) s
JOIN staging.osm_nodes o ON o.id = n.node;
CREATE INDEX ON net.vertices USING gist (geom);
