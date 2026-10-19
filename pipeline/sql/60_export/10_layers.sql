-- Tile layers. Every view here with a geometry column becomes a layer of the same name
-- (`transit export`; which file it goes into: pipeline.toml [tiles.files]).

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
WHERE EXISTS (SELECT 1 FROM net.base_edges b WHERE b.osm_edge = o.id AND b.main);

-- Crossings the model allows across arterials, by control (for checking the model).
CREATE OR REPLACE VIEW export.crossings AS
SELECT DISTINCT ON (v.node) v.node AS id, e.control,
       round(e.cost)::int AS cost_s,
       ST_Transform(v.geom, 4326)::geometry(Point, 4326) AS geom
FROM net.base_edges e JOIN net.vertices v ON v.id = e.source
WHERE e.kind = 'cross'
ORDER BY v.node, e.cost;

CREATE OR REPLACE VIEW export.hex AS
SELECT id, round(pop)::int AS pop, round(jobs)::int AS jobs,
       round(pop / area_km2)::int AS pop_km2, round(jobs / area_km2)::int AS jobs_km2,
       ST_Transform(geom, 4326)::geometry(Polygon, 4326) AS geom
FROM gen.hex;

CREATE OR REPLACE VIEW export.pois AS
SELECT id, name, category, kind, round(weight::numeric, 2)::float8 AS weight,
       ST_Transform(ST_PointOnSurface(geom), 4326)::geometry(Point, 4326) AS geom
FROM gen.pois;

CREATE OR REPLACE VIEW export.platforms AS
SELECT s.stop_id, s.stop_code AS code, s.stop_name AS name, pc.cluster_id,
       ST_Transform(s.geom, 4326)::geometry(Point, 4326) AS geom
FROM staging.stops s JOIN transit.platform_cluster pc USING (stop_id);
