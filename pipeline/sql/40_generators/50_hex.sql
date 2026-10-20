-- Hex grid of population, jobs and destinations for the density map layers, plus each
-- hex cut in halves and thirds, so the map can show two or three generators at once
-- (one per piece).
-- One point per destination (its interior point), indexed, for counting per hex.
DROP TABLE IF EXISTS gen.poi_centers;
CREATE TABLE gen.poi_centers AS SELECT id, weight, ST_PointOnSurface(geom) AS geom FROM gen.pois;
CREATE INDEX ON gen.poi_centers USING gist (geom);

DROP TABLE IF EXISTS gen.hex CASCADE;
CREATE TABLE gen.hex AS
WITH grid AS (
    SELECT h.geom
    FROM ST_HexagonGrid(:hex_size_m / sqrt(3),
                        ST_Transform(ST_MakeEnvelope(:bbox_4326, 4326), :crs)) h
)
SELECT row_number() OVER ()::int AS id, g.geom,
       coalesce((SELECT sum(pop) FROM gen.population p WHERE ST_Intersects(g.geom, p.geom)), 0) AS pop,
       coalesce((SELECT sum(jobs) FROM gen.jobs j WHERE ST_Intersects(g.geom, j.geom)), 0) AS jobs,
       -- Destination points: each POI's weight, counted at its interior point.
       coalesce((SELECT sum(weight) FROM gen.poi_centers d
                 WHERE ST_Intersects(g.geom, d.geom)), 0) AS dest
FROM grid g;
DELETE FROM gen.hex WHERE pop = 0 AND jobs = 0 AND dest = 0;
ALTER TABLE gen.hex ADD COLUMN area_km2 float8;
UPDATE gen.hex SET area_km2 = ST_Area(geom) / 1e6;

-- ST_HexagonGrid's hexes have flat tops; their ring starts at the left vertex and runs
-- counterclockwise: v0 left, v1 bottom-left, v2 bottom-right, v3 right, v4 top-right,
-- v5 top-left.
--   halves: left and right of the vertical line through the center
--   thirds: three rhombi meeting at the center (v5-v0-v1, v1-v2-v3, v3-v4-v5)
DROP TABLE IF EXISTS gen.hex_parts CASCADE;
CREATE TABLE gen.hex_parts AS
WITH v AS (
    SELECT id, ST_Centroid(geom) AS c,
           ST_PointN(ST_ExteriorRing(geom), 1) AS v0, ST_PointN(ST_ExteriorRing(geom), 2) AS v1,
           ST_PointN(ST_ExteriorRing(geom), 3) AS v2, ST_PointN(ST_ExteriorRing(geom), 4) AS v3,
           ST_PointN(ST_ExteriorRing(geom), 5) AS v4, ST_PointN(ST_ExteriorRing(geom), 6) AS v5
    FROM gen.hex
),
m AS (
    SELECT *, ST_LineInterpolatePoint(ST_MakeLine(v1, v2), 0.5) AS mb,
              ST_LineInterpolatePoint(ST_MakeLine(v4, v5), 0.5) AS mt
    FROM v
)
SELECT id AS hex_id, 'half'::text AS split, 0 AS slot,
       ST_MakePolygon(ST_MakeLine(ARRAY[v0, v1, mb, mt, v5, v0])) AS geom FROM m
UNION ALL
SELECT id, 'half', 1, ST_MakePolygon(ST_MakeLine(ARRAY[mb, v2, v3, v4, mt, mb])) FROM m
UNION ALL
SELECT id, 'third', 0, ST_MakePolygon(ST_MakeLine(ARRAY[c, v5, v0, v1, c])) FROM m
UNION ALL
SELECT id, 'third', 1, ST_MakePolygon(ST_MakeLine(ARRAY[c, v1, v2, v3, c])) FROM m
UNION ALL
SELECT id, 'third', 2, ST_MakePolygon(ST_MakeLine(ARRAY[c, v3, v4, v5, c])) FROM m;
