-- Tile layers. Every view in the export schema with a geometry column becomes a layer of
-- the same name (`transit tiles`; which file it goes into: pipeline.toml [tiles.files]).
-- Split by tile file so each file rebuilds only when its own inputs change.

-- network.pmtiles

-- The walk network as drawn under the spiderweb: one feature per OSM edge piece, with
-- the id the per-stop catchment files use.
CREATE OR REPLACE VIEW export.walk AS
SELECT o.id,
       CASE WHEN o.is_crossing THEN 'crossing'
            WHEN o.barrier THEN 'arterial'
            WHEN o.highway IN ('footway', 'path', 'cycleway', 'pedestrian', 'steps', 'bridleway',
                               'corridor', 'platform', 'track') THEN 'path'
            ELSE 'street' END AS class,
       ST_Transform(o.geom, 4326)::geometry(LineString, 4326) AS geom
FROM staging.osm_edges o
WHERE EXISTS (SELECT 1 FROM net.base_edges b WHERE b.osm_edge = o.id AND b.main)
ORDER BY o.id;

-- Crossings the model allows across arterials, by control (for checking the model).
CREATE OR REPLACE VIEW export.crossings AS
SELECT DISTINCT ON (v.node) v.node AS id, e.control,
       round(e.cost)::int AS cost_s,
       ST_Transform(v.geom, 4326)::geometry(Point, 4326) AS geom
FROM net.base_edges e JOIN net.vertices v ON v.id = e.source
WHERE e.kind = 'cross'
ORDER BY v.node, e.cost;
