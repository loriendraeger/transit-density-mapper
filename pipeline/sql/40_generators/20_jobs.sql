-- Jobs: LODES workplace counts at a point inside each block. (Spreading them over the
-- block's non-residential parcels is a possible refinement; see AGENTS.md.)
DROP TABLE IF EXISTS gen.jobs CASCADE;
CREATE TABLE gen.jobs AS
SELECT 'j' || j.geoid AS id, j.geoid, j.jobs::float8 AS jobs, ST_PointOnSurface(b.geom) AS geom
FROM staging.jobs j JOIN staging.blocks b USING (geoid)
WHERE j.jobs > 0;
CREATE INDEX ON gen.jobs USING gist (geom);
