-- Destinations: OSM POIs with a category and weight (config/poi_categories.csv).
-- Pieces of one place (same category and name, within :poi_dedupe_m) merge, keeping the
-- largest; parks and gardens scale with sqrt(area in ha).

DROP TABLE IF EXISTS gen.pois CASCADE;
CREATE TABLE gen.pois AS
WITH p AS (
    SELECT *, CASE WHEN GeometryType(geom) LIKE '%POLYGON' THEN ST_Area(geom) ELSE 0 END AS area
    FROM staging.pois
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
