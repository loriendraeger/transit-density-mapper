-- Observed weekday boardings per merged stop (MPO estimates, February 2024), to check
-- the catchment score against (`transit validate`). Not used by the site.
CREATE SCHEMA IF NOT EXISTS valid;

-- Match each ridership stop to a current GTFS platform: by stop code (the MPO stores
-- it as a number, GTFS as text with leading zeros) when the two are within 50 m, else
-- the nearest platform within 30 m (school stops have codes like W200 and no number
-- in the MPO file). The rest are stops that have closed since 2024 (South Transfer
-- Point, for one) or moved.
DROP TABLE IF EXISTS valid.ridership CASCADE;
CREATE TABLE valid.ridership AS
WITH r AS (
    SELECT fid, stop_code::int::text AS code, stop_name, weekday AS boardings,
           ST_Transform(ST_GeometryN(geom, 1), :crs) AS geom
    FROM raw.ridership
),
p AS (
    SELECT s.stop_id, ltrim(s.stop_code, '0') AS code, s.geom
    FROM staging.stops s JOIN transit.platform_cluster USING (stop_id)
),
by_code AS (
    SELECT DISTINCT ON (r.fid) r.fid, p.stop_id, ST_Distance(r.geom, p.geom) AS dist_m
    FROM r JOIN p ON p.code = r.code AND ST_DWithin(r.geom, p.geom, 50)
    ORDER BY r.fid, ST_Distance(r.geom, p.geom)
),
nearest AS (
    SELECT r.fid, n.stop_id, n.dist_m
    FROM r CROSS JOIN LATERAL (
        SELECT p.stop_id, ST_Distance(r.geom, p.geom) AS dist_m
        FROM p ORDER BY r.geom <-> p.geom LIMIT 1
    ) n
    WHERE n.dist_m <= 30
)
SELECT r.fid, r.code, r.stop_name, r.boardings, r.geom,
       coalesce(c.stop_id, n.stop_id) AS stop_id,
       CASE WHEN c.stop_id IS NOT NULL THEN 'code'
            WHEN n.stop_id IS NOT NULL THEN 'nearest' END AS matched_by,
       coalesce(c.dist_m, n.dist_m) AS dist_m
FROM r
LEFT JOIN by_code c USING (fid)
LEFT JOIN nearest n USING (fid);

-- Boardings per merged stop (sum over its platforms).
DROP TABLE IF EXISTS valid.cluster_ridership;
CREATE TABLE valid.cluster_ridership AS
SELECT pc.cluster_id, sum(r.boardings) AS boardings, count(*) AS n_matched
FROM valid.ridership r
JOIN transit.platform_cluster pc USING (stop_id)
GROUP BY 1;
