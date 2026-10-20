-- Tile layers. Every view in the export schema with a geometry column becomes a layer of
-- the same name (`transit tiles`; which file it goes into: pipeline.toml [tiles.files]).
-- Split by tile file so each file rebuilds only when its own inputs change.

-- generators.pmtiles

DROP VIEW IF EXISTS export.hex, export.hex_parts;
-- d_<category>: destination points per km2 by category (gen.hex_dest); the site sums
-- them with the user's category weights.
CREATE OR REPLACE VIEW export.hex AS
SELECT h.id, round(h.pop)::int AS pop, round(h.jobs)::int AS jobs,
       round(h.pop / h.area_km2)::int AS pop_km2, round(h.jobs / h.area_km2)::int AS jobs_km2,
       d.*,
       ST_Transform(h.geom, 4326)::geometry(Polygon, 4326) AS geom
FROM gen.hex h JOIN gen.hex_dest d ON d.hex_id = h.id
ORDER BY h.id;

-- Hex halves and thirds (40_generators/50_hex.sql) with the same densities, so the map
-- can give each selected generator its own piece.
CREATE OR REPLACE VIEW export.hex_parts AS
SELECT row_number() OVER (ORDER BY p.hex_id, p.split, p.slot)::int AS id, p.split, p.slot,
       round(h.pop / h.area_km2)::int AS pop_km2, round(h.jobs / h.area_km2)::int AS jobs_km2,
       d.*,
       ST_Transform(p.geom, 4326)::geometry(Polygon, 4326) AS geom
FROM gen.hex_parts p JOIN gen.hex h ON h.id = p.hex_id JOIN gen.hex_dest d ON d.hex_id = h.id
ORDER BY 1;

-- osm_id, not id: tippecanoe uses `id` as the numeric feature id, and these are text.
DROP VIEW IF EXISTS export.pois;
CREATE OR REPLACE VIEW export.pois AS
SELECT id AS osm_id, name, category, kind, round(weight::numeric, 2)::float8 AS weight,
       ST_Transform(ST_PointOnSurface(geom), 4326)::geometry(Point, 4326) AS geom
FROM gen.pois
ORDER BY id;

CREATE OR REPLACE VIEW export.platforms AS
SELECT s.stop_id, s.stop_code AS code, s.stop_name AS name, pc.cluster_id,
       ST_Transform(s.geom, 4326)::geometry(Point, 4326) AS geom
FROM staging.stops s JOIN transit.platform_cluster pc USING (stop_id)
ORDER BY s.stop_id;

-- Route lines (GTFS shapes), drawn under the stops in Metro's route colors.
CREATE OR REPLACE VIEW export.routes AS
SELECT row_number() OVER (ORDER BY sort_order, route_id, shape_id)::int AS id,
       route_id, name, color, coalesce(sort_order, 999) AS sort_order,
       ST_Transform(ST_Simplify(geom, 3), 4326)::geometry(LineString, 4326) AS geom
FROM transit.route_lines
ORDER BY 1;
