-- Schools with enrollment (NCES), one table: public K-12 (CCD), private K-12 (PSS) and
-- colleges (IPEDS), as points in the study area. Enrollment is what school trips scale
-- with (40_generators/35_schools.sql).
DROP TABLE IF EXISTS staging.schools CASCADE;
CREATE TABLE staging.schools AS
WITH bbox AS (SELECT ST_MakeEnvelope(:bbox_4326, 4326) AS geom),
-- Public: open schools with a building to go to (fully virtual ones have none;
-- "supplemental virtual" schools are ordinary schools with some online courses).
public AS (
    SELECT 'ccd' || ncessch AS id, sch_name AS name, 'k12' AS level, total::float8 AS students,
           ST_SetSRID(ST_MakePoint(loncod, latcod), 4326) AS geom
    FROM raw.ccd_schools
    WHERE sy_status_text = 'Open' AND virtual <> 'Full Virtual' AND total > 0
),
private AS (
    SELECT 'pss' || ppin, pinst, 'k12', numstuds::float8,
           ST_SetSRID(ST_MakePoint(longitude22::float8, latitude22::float8), 4326)
    FROM raw.pss_schools
    WHERE numstuds::float8 > 0
),
-- Colleges: fall headcount minus students enrolled only in distance education.
college AS (
    SELECT 'ipeds' || h.unitid, h.instnm, 'college',
           (e.efdetot::float8 - coalesce(e.efdeexc::float8, 0)),
           ST_SetSRID(ST_MakePoint(h.longitud::float8, h.latitude::float8), 4326)
    FROM raw.ipeds_hd h
    JOIN raw.ipeds_ef_dist e ON e.unitid = h.unitid AND e.efdelev = '1'
    WHERE e.efdetot::float8 - coalesce(e.efdeexc::float8, 0) > 0
)
SELECT s.id, s.name, s.level, s.students, ST_Transform(s.geom, :crs) AS geom
FROM (SELECT * FROM public UNION ALL SELECT * FROM private UNION ALL SELECT * FROM college) s,
     bbox
WHERE ST_Intersects(s.geom, bbox.geom);
ALTER TABLE staging.schools ADD PRIMARY KEY (id);
CREATE INDEX ON staging.schools USING gist (geom);
