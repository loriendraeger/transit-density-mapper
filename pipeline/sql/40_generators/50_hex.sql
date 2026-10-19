-- Hex grid of population and jobs for the density map layers.
DROP TABLE IF EXISTS gen.hex CASCADE;
CREATE TABLE gen.hex AS
WITH grid AS (
    SELECT h.geom
    FROM ST_HexagonGrid(:hex_size_m / sqrt(3),
                        ST_Transform(ST_MakeEnvelope(:bbox_4326, 4326), :crs)) h
)
SELECT row_number() OVER ()::int AS id, g.geom,
       coalesce((SELECT sum(pop) FROM gen.population p WHERE ST_Intersects(g.geom, p.geom)), 0) AS pop,
       coalesce((SELECT sum(jobs) FROM gen.jobs j WHERE ST_Intersects(g.geom, j.geom)), 0) AS jobs
FROM grid g;
DELETE FROM gen.hex WHERE pop = 0 AND jobs = 0;
ALTER TABLE gen.hex ADD COLUMN area_km2 float8;
UPDATE gen.hex SET area_km2 = ST_Area(geom) / 1e6;
