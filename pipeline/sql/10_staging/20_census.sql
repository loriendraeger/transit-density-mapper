-- 2020 census blocks (population and housing units) and LODES jobs per block.

DROP TABLE IF EXISTS staging.blocks CASCADE;
CREATE TABLE staging.blocks AS
SELECT geoid20 AS geoid, pop20::int AS pop, housing20::int AS housing,
       aland20::float8 AS aland_m2,
       ST_Multi(ST_Transform(geom, :crs))::geometry(MultiPolygon, :crs) AS geom
FROM raw.blocks
WHERE countyfp20 = '025';   -- Dane County; the bbox barely touches neighbors
ALTER TABLE staging.blocks ADD PRIMARY KEY (geoid);
CREATE INDEX ON staging.blocks USING gist (geom);

-- LODES WAC: jobs by workplace block. C000 = all jobs; CNS01-20 = NAICS sectors.
DROP TABLE IF EXISTS staging.jobs;
CREATE TABLE staging.jobs AS
SELECT w.w_geocode AS geoid, w.c000 AS jobs,
       w.cns07 AS retail, w.cns18 AS food_lodging, w.cns15 AS education, w.cns16 AS health,
       w.cns17 AS arts_rec, w.cns09 + w.cns10 + w.cns12 + w.cns13 + w.cns14 AS office,
       w.cns05 + w.cns08 AS industrial
FROM raw.lodes_wac w
JOIN staging.blocks b ON b.geoid = w.w_geocode;
ALTER TABLE staging.jobs ADD PRIMARY KEY (geoid);
