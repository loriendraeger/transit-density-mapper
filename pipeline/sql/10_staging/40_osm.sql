-- OSM network edges, nodes and POIs in :crs, with road classes and POI categories from
-- config/.

DROP TABLE IF EXISTS staging.road_classes;
CREATE TABLE staging.road_classes (
    highway text PRIMARY KEY, walkable boolean, barrier boolean, wait_signal_s float8,
    wait_marked_s float8, wait_unmarked_s float8, crossing_width_m float8, notes text);
\copy staging.road_classes FROM 'config/road_classes.csv' CSV HEADER

DROP TABLE IF EXISTS staging.osm_edges CASCADE;
CREATE TABLE staging.osm_edges AS
SELECT
    row_number() OVER (ORDER BY e.way_id, e.seq)::int AS id,
    e.way_id, e.seq, e.source, e.target,
    e.tags->>'highway' AS highway,
    e.tags->>'name' AS name,
    -- An explicit pedestrian crossing (footway=crossing, or highway=crossing on a way).
    coalesce(e.tags->>'footway' = 'crossing' OR e.tags->>'highway' = 'crossing'
             OR e.tags->>'cycleway' = 'crossing' OR e.tags->>'path' = 'crossing', false)
        AS is_crossing,
    e.tags->>'crossing' AS crossing,
    e.tags->>'crossing:markings' AS crossing_markings,
    e.tags->>'crossing:signals' AS crossing_signals,
    e.tags->>'oneway' IN ('yes', '1', '-1') AS oneway,
    coalesce(rc.barrier, false) AS barrier,
    ST_Transform(e.geom, :crs)::geometry(LineString, :crs) AS geom
FROM raw.osm_edges e
JOIN staging.road_classes rc ON rc.highway = e.tags->>'highway'
WHERE rc.walkable
  AND ST_Length(e.geom::geography) > 0;
ALTER TABLE staging.osm_edges ADD PRIMARY KEY (id);
CREATE INDEX ON staging.osm_edges (source);
CREATE INDEX ON staging.osm_edges (target);
CREATE INDEX ON staging.osm_edges USING gist (geom);

DROP TABLE IF EXISTS staging.osm_nodes CASCADE;
CREATE TABLE staging.osm_nodes AS
SELECT DISTINCT ON (id) id, tags, ST_Transform(geom, :crs)::geometry(Point, :crs) AS geom
FROM raw.osm_nodes;
ALTER TABLE staging.osm_nodes ADD PRIMARY KEY (id);
CREATE INDEX ON staging.osm_nodes USING gist (geom);

-- Buildings: residential ones estimate dwelling units outside Madison; the rest place
-- college enrollment on campus (40_generators/35_schools.sql).
DROP TABLE IF EXISTS staging.buildings CASCADE;
CREATE TABLE staging.buildings AS
SELECT building,
       CASE WHEN levels ~ '^[0-9]+(\.[0-9]+)?$' THEN levels::float8 END AS levels,
       ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_Transform(geom, :crs)), 3))
           ::geometry(MultiPolygon, :crs) AS geom
FROM raw.osm_buildings;
ALTER TABLE staging.buildings ADD COLUMN area_m2 float8;
UPDATE staging.buildings SET area_m2 = ST_Area(geom);
CREATE INDEX ON staging.buildings USING gist (geom);

DROP TABLE IF EXISTS staging.res_buildings;
CREATE TABLE staging.res_buildings AS
SELECT * FROM staging.buildings
WHERE building IN ('apartments', 'residential', 'dormitory', 'house', 'detached',
                   'semidetached_house', 'terrace', 'duplex', 'bungalow');
CREATE INDEX ON staging.res_buildings USING gist (geom);
