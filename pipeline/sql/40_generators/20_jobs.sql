-- Jobs: LODES workplace counts at a point inside each block. (Spreading them over the
-- block's non-residential parcels is a possible refinement; see AGENTS.md.)
DROP TABLE IF EXISTS gen.jobs CASCADE;
CREATE TABLE gen.jobs AS
-- shop_jobs: retail and health-care jobs (LODES CNS07, CNS16), a measure of how big the
-- block's shops and clinics are; part of "other destinations" (customer and patient
-- trips scale with them; OSM counts a supermarket and a corner store alike).
SELECT 'j' || j.geoid AS id, j.geoid, j.jobs::float8 AS jobs,
       (j.retail + j.health)::float8 AS shop_jobs, ST_PointOnSurface(b.geom) AS geom
FROM staging.jobs j JOIN staging.blocks b USING (geoid)
WHERE j.jobs > 0;
CREATE INDEX ON gen.jobs USING gist (geom);
