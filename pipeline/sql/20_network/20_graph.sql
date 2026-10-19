-- The routing graph: net.base_edges (id, source, target, cost in seconds), undirected.
-- 30_stops/ copies it to net.edges with edges split at bus stop platforms.
--   walk     ordinary walkways and minor streets, between ordinary vertices or corners
--   side_l/  the two sides of a barrier road (walking along it), each between the
--   side_r   corners on that side at either end
--   cross    a crossing connector between two corners of one barrier node, costing
--            the expected wait plus the time to walk across

-- How a crossing is controlled: signal > marked > unmarked. From OSM tags on a crossing
-- way or a crossing node.
-- `untagged` is the rank of a crossing tagged with nothing more (:untagged_crossing).
-- (psql variables don't expand inside a function body, so it's an argument.)
SELECT CASE :'untagged_crossing' WHEN 'marked' THEN 2 ELSE 1 END AS untagged \gset
DROP FUNCTION IF EXISTS net.control_rank;
CREATE FUNCTION net.control_rank(
    hw text, crossing text, markings text, signals text, untagged int)
RETURNS int LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN hw = 'traffic_signals' OR crossing = 'traffic_signals' OR signals = 'yes' THEN 3
        WHEN crossing IN ('unmarked', 'no') OR markings = 'no' THEN 1
        WHEN crossing IN ('marked', 'zebra', 'uncontrolled', 'island')
             OR (markings IS NOT NULL AND markings <> 'no') THEN 2
        WHEN hw = 'crossing' OR crossing IS NOT NULL THEN untagged
        ELSE 0
    END
$$;

-- Control at each barrier node: the best of
--   (a) crossing ways that pass through it (footway=crossing ends at the node),
--   (b) the node's own tags (highway=crossing / traffic_signals),
--   (c) a traffic signal within :signal_search_m (signals are often tagged on the
--       junction or stop line rather than on the crossing).
-- 0 = no crossing evidence at all (an ordinary junction): treated like unmarked.
DROP TABLE IF EXISTS net.node_control;
CREATE TABLE net.node_control AS
WITH bn AS (SELECT DISTINCT node FROM net.arms WHERE n_arms > 1)
SELECT bn.node,
       greatest(
           (SELECT max(net.control_rank(e.highway, e.crossing, e.crossing_markings,
                                        e.crossing_signals, :untagged))
            FROM net.ends x JOIN staging.osm_edges e ON e.id = x.edge_id
            WHERE x.node = bn.node AND e.is_crossing),
           net.control_rank(o.tags->>'highway', o.tags->>'crossing',
                            o.tags->>'crossing:markings', o.tags->>'crossing:signals', :untagged),
           (SELECT 3 FROM staging.osm_nodes s
            WHERE s.tags->>'highway' = 'traffic_signals'
              AND ST_DWithin(s.geom, o.geom, :signal_search_m) LIMIT 1),
           0) AS control
FROM bn JOIN staging.osm_nodes o ON o.id = bn.node;

DROP TABLE IF EXISTS net.base_edges CASCADE;
CREATE TABLE net.base_edges (
    id serial PRIMARY KEY,
    osm_edge int,            -- staging.osm_edges.id (NULL for crossing connectors)
    kind text NOT NULL,
    source int NOT NULL,
    target int NOT NULL,
    cost float8 NOT NULL,    -- seconds
    control int,             -- crossing connectors: 1 unmarked, 2 marked, 3 signal
    geom geometry(LineString, :crs),
    geom_snap geometry(LineString, :crs));

-- Ordinary walkways: ends at a barrier node attach to their corner, else sector 0.
INSERT INTO net.base_edges (osm_edge, kind, source, target, cost, geom, geom_snap)
SELECT e.id, 'walk', vs.id, vt.id, ST_Length(e.geom) / :walk_speed_mps, e.geom, e.geom
FROM staging.osm_edges e
LEFT JOIN net.end_sector ss ON ss.edge_id = e.id AND ss.at_source
LEFT JOIN net.end_sector st ON st.edge_id = e.id AND NOT st.at_source
JOIN net.vertices vs ON vs.node = e.source AND vs.sector = coalesce(ss.sector, 0)
JOIN net.vertices vt ON vt.node = e.target AND vt.sector = coalesce(st.sector, 0)
WHERE NOT e.barrier;

-- Barrier roads: one copy per side. The right side (in digitized direction) joins the
-- source end's right corner to the target end's left corner (seen from the target,
-- looking back along the edge, the edge's right side is on the left). Snapping uses a
-- copy offset to that side (ST_OffsetCurve: positive = left).
INSERT INTO net.base_edges (osm_edge, kind, source, target, cost, geom, geom_snap)
SELECT e.id, side.kind,
       (SELECT id FROM net.vertices v WHERE v.node = e.source
          AND v.sector = CASE side.kind WHEN 'side_r' THEN a1.right_sector ELSE a1.left_sector END),
       (SELECT id FROM net.vertices v WHERE v.node = e.target
          AND v.sector = CASE side.kind WHEN 'side_r' THEN a2.left_sector ELSE a2.right_sector END),
       ST_Length(e.geom) / :walk_speed_mps,
       e.geom,
       coalesce(
           (SELECT g FROM (SELECT ST_OffsetCurve(e.geom, side.sign * :side_offset_m) AS g) o
            WHERE GeometryType(g) = 'LINESTRING' AND NOT ST_IsEmpty(g)),
           e.geom)
FROM staging.osm_edges e
JOIN net.arms a1 ON a1.edge_id = e.id AND a1.at_source
JOIN net.arms a2 ON a2.edge_id = e.id AND NOT a2.at_source
CROSS JOIN (VALUES ('side_r', -1), ('side_l', 1)) AS side (kind, sign)
WHERE e.barrier;

-- Crossing connectors: crossing arm i of a barrier node joins its left and right corners.
-- Several arms can join the same pair of corners (a straight road has two arms, both
-- separating corners 1 and 2); keep the cheapest. Unmarked crossings (or no crossing
-- evidence) are allowed only where the road class has a wait_unmarked_s.
INSERT INTO net.base_edges (kind, source, target, cost, control, geom)
SELECT DISTINCT ON (least(vl.id, vr.id), greatest(vl.id, vr.id))
       'cross', vl.id, vr.id, c.cost, c.control, ST_MakeLine(vl.geom, vr.geom)
FROM net.arms a
JOIN staging.osm_edges e ON e.id = a.edge_id
JOIN staging.road_classes rc ON rc.highway = e.highway
JOIN net.node_control nc ON nc.node = a.node
CROSS JOIN LATERAL (
    SELECT greatest(nc.control, 1) AS control,
           CASE greatest(nc.control, 1)
               WHEN 3 THEN rc.wait_signal_s WHEN 2 THEN rc.wait_marked_s
               ELSE rc.wait_unmarked_s END
           * CASE WHEN e.oneway THEN :oneway_wait_factor ELSE 1 END
           + coalesce(rc.crossing_width_m, 0)
             * CASE WHEN e.oneway THEN 0.5 ELSE 1 END / :walk_speed_mps AS cost
) c
JOIN net.vertices vl ON vl.node = a.node AND vl.sector = a.left_sector
JOIN net.vertices vr ON vr.node = a.node AND vr.sector = a.right_sector
WHERE a.n_arms > 1 AND c.cost IS NOT NULL
ORDER BY least(vl.id, vr.id), greatest(vl.id, vr.id), c.cost;

-- Crossing ways that cut across a barrier road without sharing a node with it (a
-- mapping shortcut) still cross it: charge the wait for their own control, and drop
-- them where that kind of crossing isn't allowed.
WITH hits AS (
    SELECT w.id, max(
        CASE greatest(net.control_rank(e.highway, e.crossing, e.crossing_markings,
                                       e.crossing_signals, :untagged), 1)
            WHEN 3 THEN rc.wait_signal_s WHEN 2 THEN rc.wait_marked_s
            ELSE coalesce(rc.wait_unmarked_s, 'infinity') END) AS wait
    FROM net.base_edges w
    JOIN staging.osm_edges e ON e.id = w.osm_edge AND e.is_crossing
    JOIN staging.osm_edges b ON b.barrier AND ST_Intersects(b.geom, e.geom)
     AND e.source NOT IN (b.source, b.target) AND e.target NOT IN (b.source, b.target)
    JOIN staging.road_classes rc ON rc.highway = b.highway
    WHERE w.kind = 'walk'
    GROUP BY w.id
)
UPDATE net.base_edges w SET cost = w.cost + hits.wait FROM hits WHERE hits.id = w.id;
DELETE FROM net.base_edges WHERE cost = 'infinity';

CREATE INDEX ON net.base_edges (source);
CREATE INDEX ON net.base_edges (target);
CREATE INDEX ON net.base_edges USING gist (geom);
CREATE INDEX ON net.base_edges USING gist (geom_snap);

-- Connected components: stops and generators snap only to the main network, so a
-- disconnected scrap of sidewalk can't swallow a bus stop.
ALTER TABLE net.vertices ADD COLUMN IF NOT EXISTS component bigint;
UPDATE net.vertices v SET component = c.component
FROM pgr_connectedComponents('SELECT id, source, target, cost, cost AS reverse_cost FROM net.base_edges') c
WHERE c.node = v.id;
ALTER TABLE net.base_edges ADD COLUMN main boolean;
UPDATE net.base_edges e SET main = v.component = (
    SELECT component FROM net.vertices WHERE component IS NOT NULL
    GROUP BY component ORDER BY count(*) DESC LIMIT 1)
FROM net.vertices v WHERE v.id = e.source;
ANALYZE net.base_edges;
