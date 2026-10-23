-- POIs tagged with a destination category: the first matching rule in
-- config/poi_categories.csv wins (value * = any). In the generators stage rather than
-- staging, so changing a weight reruns only what depends on destinations.
DROP TABLE IF EXISTS gen.poi_rules;
CREATE TABLE gen.poi_rules (key text, value text, category text, weight float8, notes text);
\copy gen.poi_rules (key, value, category, weight, notes) FROM 'config/poi_categories.csv' CSV HEADER
ALTER TABLE gen.poi_rules ADD COLUMN priority serial;

DROP TABLE IF EXISTS gen.poi_tagged CASCADE;
CREATE TABLE gen.poi_tagged AS
SELECT DISTINCT ON (p.osm_type, p.osm_id)
    p.osm_type || p.osm_id AS id,
    p.tags->>'name' AS name,
    r.category, r.key, r.value AS kind, r.weight,
    p.tags->>'access' AS access,
    ST_Transform(p.geom, :crs) AS geom
FROM raw.osm_pois p
JOIN gen.poi_rules r
  ON p.tags ? r.key AND (r.value = '*' OR p.tags->>r.key = r.value)
ORDER BY p.osm_type, p.osm_id, r.priority;
-- Private facilities aren't destinations (private pools, members-only gyms...).
DELETE FROM gen.poi_tagged WHERE access IN ('private', 'no') OR category = 'ignore';
ALTER TABLE gen.poi_tagged ADD PRIMARY KEY (id);
CREATE INDEX ON gen.poi_tagged USING gist (geom);

-- Destinations: OSM POIs with a category and weight (config/poi_categories.csv).
-- Pieces of one place (same category and name, within :poi_dedupe_m) merge, keeping the
-- largest; parks and gardens scale with sqrt(area in ha).

DROP TABLE IF EXISTS gen.pois CASCADE;
CREATE TABLE gen.pois AS
WITH p AS (
    SELECT *, CASE WHEN GeometryType(geom) LIKE '%POLYGON' THEN ST_Area(geom) ELSE 0 END AS area
    FROM gen.poi_tagged
),
named AS (
    -- Cluster same-named places of one category; unnamed POIs stay separate.
    SELECT p.*, ST_ClusterDBSCAN(geom, :poi_dedupe_m, 1)
                OVER (PARTITION BY category, lower(name)) AS grp
    FROM p WHERE name IS NOT NULL
),
dedup AS (
    (SELECT DISTINCT ON (category, lower(name), grp) id, name, category, kind, weight, area, geom
     FROM named ORDER BY category, lower(name), grp, area DESC)
    UNION ALL
    SELECT id, name, category, kind, weight, area, geom FROM p WHERE name IS NULL
)
SELECT id, name, category, kind,
       weight * CASE WHEN category IN ('parks', 'gardens') THEN
           least(greatest(sqrt(area / 10000), :park_scale_min), :park_scale_max)
           ELSE 1 END AS weight,
       area AS area_m2,
       geom
FROM dedup;
ALTER TABLE gen.pois ADD PRIMARY KEY (id);
CREATE INDEX ON gen.pois USING gist (geom);

-- Drop places inside a bigger place of the same category (:poi_nested_categories):
-- they're part of it.
DELETE FROM gen.pois p
USING gen.pois q
WHERE p.category = q.category
  AND p.category = ANY (string_to_array(:'poi_nested_categories', ','))
  AND q.id <> p.id
  AND q.area_m2 > p.area_m2
  AND q.geom && p.geom
  AND ST_Contains(q.geom, ST_PointOnSurface(p.geom));

-- Schools and colleges count by enrollment (35_schools.sql), not as weighted
-- destinations: their OSM places move to gen.edu_places, where they locate the NCES
-- schools (and mark school and campus stops, 70_validation/20_special.sql).
DROP TABLE IF EXISTS gen.edu_places CASCADE;
CREATE TABLE gen.edu_places AS
SELECT * FROM gen.pois WHERE category = :'enrollment_category';
ALTER TABLE gen.edu_places ADD PRIMARY KEY (id);
CREATE INDEX ON gen.edu_places USING gist (geom);
DELETE FROM gen.pois WHERE category = :'enrollment_category';

-- Destination totals by trip purpose: each group of categories gets the share of trips
-- made for its purpose (gen.purpose_shares, from the NHTS by `transit purposes`), while
-- the overall total stays the same. Within a group, the poi_categories.csv weights (and
-- the park area scaling) still rank places against each other.
DROP TABLE IF EXISTS gen.dest_groups;
CREATE TABLE gen.dest_groups (category text PRIMARY KEY, grp text, note text);
\copy gen.dest_groups FROM 'config/destination_groups.csv' CSV HEADER
DO $$
BEGIN
    IF EXISTS (SELECT DISTINCT category FROM gen.pois
               EXCEPT SELECT category FROM gen.dest_groups) THEN
        RAISE EXCEPTION 'a POI category is missing from config/destination_groups.csv';
    END IF;
END $$;
WITH g AS (
    SELECT dg.grp, sum(p.weight) AS total
    FROM gen.pois p JOIN gen.dest_groups dg USING (category)
    GROUP BY dg.grp
),
f AS (
    SELECT g.grp, s.share * (SELECT sum(weight) FROM gen.pois) / g.total AS factor
    FROM g JOIN gen.purpose_shares s USING (grp)
)
UPDATE gen.pois p SET weight = p.weight * f.factor
FROM gen.dest_groups dg JOIN f USING (grp)
WHERE dg.category = p.category;

-- Access points: a point inside each POI, plus points along polygon outlines.
DROP TABLE IF EXISTS gen.poi_points CASCADE;
CREATE TABLE gen.poi_points AS
SELECT id AS poi_id, ST_PointOnSurface(geom) AS geom FROM gen.pois
UNION ALL
SELECT p.id, (ST_DumpPoints(ST_LineInterpolatePoints(r.ring,
                least(1, :poi_outline_step_m / greatest(ST_Length(r.ring), 1))))).geom
FROM gen.pois p
CROSS JOIN LATERAL (
    SELECT ST_ExteriorRing((ST_Dump(p.geom)).geom) AS ring
) r
WHERE p.area_m2 > 0 AND ST_Length(r.ring) > :poi_outline_step_m;
CREATE INDEX ON gen.poi_points USING gist (geom);
