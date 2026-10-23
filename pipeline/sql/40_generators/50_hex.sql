-- Hex grid of population, jobs and destinations for the density map layers, plus each
-- hex cut in halves and thirds, so the map can show two or three generators at once
-- (one per piece).
-- Destination weight per hex: a point counts in the hex it falls in; an area (park,
-- garden, campus) spreads its weight over the hexes it covers, by area, so one big place
-- shades several hexes lightly instead of one hex darkly.
DROP TABLE IF EXISTS gen.poi_hex;
CREATE TABLE gen.poi_hex (hex_id int, category text, weight float8);
DROP TABLE IF EXISTS gen.hex CASCADE;
CREATE TABLE gen.hex AS
WITH grid AS (
    SELECT h.geom
    FROM ST_HexagonGrid(:hex_size_m / sqrt(3),
                        ST_Transform(ST_MakeEnvelope(:bbox_4326, 4326), :crs)) h
)
SELECT row_number() OVER ()::int AS id, g.geom,
       coalesce((SELECT sum(pop::numeric) FROM gen.population p WHERE ST_Intersects(g.geom, p.geom)), 0)::float8 AS pop,
       coalesce((SELECT sum(jobs::numeric) FROM gen.jobs j WHERE ST_Intersects(g.geom, j.geom)), 0)::float8 AS jobs,
       coalesce((SELECT sum(shop_jobs::numeric) FROM gen.jobs j WHERE ST_Intersects(g.geom, j.geom)), 0)::float8 AS shop_jobs,
       -- School trip ends a day, at one point per generator (a campus building, the
       -- school grounds, or the NCES point).
       coalesce((SELECT sum(value::numeric) FROM gen.school_points s WHERE s.main AND ST_Intersects(g.geom, s.geom)), 0)::float8 AS school,
       0::float8 AS dest
FROM grid g;
CREATE INDEX ON gen.hex USING gist (geom);
INSERT INTO gen.poi_hex
SELECT h.id, p.category, p.weight
FROM gen.pois p JOIN gen.hex h ON ST_Intersects(h.geom, p.geom)
WHERE p.area_m2 = 0
UNION ALL
SELECT h.id, p.category, p.weight * ST_Area(ST_Intersection(h.geom, p.geom)) / p.area_m2
FROM gen.pois p JOIN gen.hex h ON ST_Intersects(h.geom, p.geom)
WHERE p.area_m2 > 0;
UPDATE gen.hex h SET dest = d.w
FROM (SELECT hex_id, sum(weight::numeric)::float8 AS w FROM gen.poi_hex GROUP BY hex_id) d
WHERE d.hex_id = h.id;
DELETE FROM gen.hex WHERE pop = 0 AND jobs = 0 AND dest < 0.01 AND school = 0;
ALTER TABLE gen.hex ADD COLUMN area_km2 float8;
UPDATE gen.hex SET area_km2 = ST_Area(geom) / 1e6;

-- Destination points per hex and category, as one column per category (d_<category>,
-- points per km2, NULL when none) so the site can re-weight categories and recolor the
-- destinations layer. The columns follow the categories in the data, so the table's
-- SQL is generated (\gexec runs each row of the query's result as a statement).
DROP TABLE IF EXISTS gen.hex_dest CASCADE;
SELECT format(
    'CREATE TABLE gen.hex_dest AS SELECT h.id AS hex_id, %s FROM gen.hex h '
    'LEFT JOIN gen.poi_hex p ON p.hex_id = h.id GROUP BY h.id, h.area_km2',
    string_agg(format('nullif(round(coalesce(sum(p.weight::numeric) FILTER (WHERE p.category = %L), 0) '
                      '/ h.area_km2)::int, 0) AS %I', category, 'd_' || category),
               ', ' ORDER BY category))
FROM (SELECT DISTINCT category FROM gen.pois) c
\gexec
ALTER TABLE gen.hex_dest ADD PRIMARY KEY (hex_id);

-- ST_HexagonGrid's hexes have flat tops; their ring starts at the left vertex and runs
-- counterclockwise: v0 left, v1 bottom-left, v2 bottom-right, v3 right, v4 top-right,
-- v5 top-left.
--   halves: left and right of the vertical line through the center
--   thirds: three wedges from the center to the midpoints of alternating edges
--           (v0-v1, v2-v3, v4-v5). Equal areas; not rhombi, which side by side read as
--           3D cubes (the "tumbling blocks" illusion; owner's call 2026-10-19).
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
              ST_LineInterpolatePoint(ST_MakeLine(v4, v5), 0.5) AS mt,
              ST_LineInterpolatePoint(ST_MakeLine(v0, v1), 0.5) AS m01,
              ST_LineInterpolatePoint(ST_MakeLine(v2, v3), 0.5) AS m23
    FROM v
)
SELECT id AS hex_id, 'half'::text AS split, 0 AS slot,
       ST_MakePolygon(ST_MakeLine(ARRAY[v0, v1, mb, mt, v5, v0])) AS geom FROM m
UNION ALL
SELECT id, 'half', 1, ST_MakePolygon(ST_MakeLine(ARRAY[mb, v2, v3, v4, mt, mb])) FROM m
UNION ALL
SELECT id, 'third', 0, ST_MakePolygon(ST_MakeLine(ARRAY[c, mt, v5, v0, m01, c])) FROM m
UNION ALL
SELECT id, 'third', 1, ST_MakePolygon(ST_MakeLine(ARRAY[c, m01, v1, v2, m23, c])) FROM m
UNION ALL
SELECT id, 'third', 2, ST_MakePolygon(ST_MakeLine(ARRAY[c, m23, v3, v4, mt, c])) FROM m;
