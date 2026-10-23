-- School trip ends: NCES enrollment (staging.schools) x the NHTS's school trip ends per
-- student a day (gen.trip_rates, by level: K-12 students go most days, college students
-- far less often). Travel-demand models treat enrollment as the attraction for school
-- trips the way jobs attract work trips; a flat weight per OSM school counted a
-- 48,000-student university like a small college (2026-10-23).
DROP TABLE IF EXISTS gen.schools CASCADE;
CREATE TABLE gen.schools AS
SELECT s.id, s.name, s.level, s.students, s.students * r.value AS trip_ends,
       m.place_id, s.geom
FROM staging.schools s
JOIN gen.trip_rates r
  ON r.key = CASE s.level WHEN 'k12' THEN 'school_per_k12_student'
                          ELSE 'school_per_college_student' END
-- Its OSM place: K-12 schools take school grounds, colleges a campus (the smallest
-- grounds or the largest campus at the point, else the nearest within the match
-- distance).
LEFT JOIN LATERAL (
    SELECT e.id AS place_id
    FROM gen.edu_places e
    WHERE e.area_m2 > 0
      AND (e.kind = 'school') = (s.level = 'k12')
      AND ST_DWithin(e.geom, s.geom,
                     CASE s.level WHEN 'k12' THEN :school_match_m ELSE :college_match_m END)
    ORDER BY ST_Distance(e.geom, s.geom),
             CASE s.level WHEN 'k12' THEN e.area_m2 ELSE -e.area_m2 END, e.id
    LIMIT 1
) m ON true;
ALTER TABLE gen.schools ADD PRIMARY KEY (id);
-- A campus belongs to its largest college: a small school whose point falls inside it
-- (a beauty school on State Street inside OSM's UW-Madison outline) keeps its own point.
-- K-12 schools may share grounds.
UPDATE gen.schools s SET place_id = NULL
WHERE s.level = 'college' AND EXISTS (
    SELECT 1 FROM gen.schools o
    WHERE o.level = 'college' AND o.place_id = s.place_id
      AND (o.students, o.id) > (s.students, s.id));

-- Campus buildings that students go to: on the campus, not homes or sheds, big enough.
DROP TABLE IF EXISTS gen.campus_buildings CASCADE;
CREATE TABLE gen.campus_buildings AS
SELECT s.id AS school_id,
       row_number() OVER (PARTITION BY s.id ORDER BY ST_X(ST_PointOnSurface(b.geom)),
                          ST_Y(ST_PointOnSurface(b.geom))) AS n,
       b.area_m2 * coalesce(b.levels, :default_levels) AS floor_m2,
       ST_PointOnSurface(b.geom) AS geom
FROM gen.schools s
JOIN gen.edu_places e ON e.id = s.place_id
JOIN staging.buildings b
  ON b.geom && e.geom AND ST_Intersects(e.geom, ST_PointOnSurface(b.geom))
WHERE s.level = 'college'
  AND b.area_m2 >= :campus_building_min_m2
  AND NOT b.building = ANY (string_to_array(:'campus_skip_buildings', ','));

-- Generator points (all of one school's points share its gen_id, so a stop counts it once,
-- at its quickest point; 55_catchments/10_gen_time.sql):
--   college with campus buildings: one generator per building, its share of the
--     school's trip ends by floor area
--   school with grounds: a point inside plus points along the outline, like a park
--   otherwise: the NCES point
-- `main` marks one point per generator, for the density hexes.
DROP TABLE IF EXISTS gen.school_points CASCADE;
CREATE TABLE gen.school_points AS
SELECT s.id || '-' || b.n AS gen_id, s.id AS school_id,
       s.trip_ends * b.floor_m2 / sum(b.floor_m2) OVER (PARTITION BY s.id) AS value,
       true AS main, b.geom
FROM gen.schools s JOIN gen.campus_buildings b ON b.school_id = s.id
UNION ALL
SELECT s.id, s.id, s.trip_ends, true, ST_PointOnSurface(e.geom)
FROM gen.schools s JOIN gen.edu_places e ON e.id = s.place_id
WHERE NOT EXISTS (SELECT 1 FROM gen.campus_buildings b WHERE b.school_id = s.id)
UNION ALL
SELECT s.id, s.id, s.trip_ends, false,
       (ST_DumpPoints(ST_LineInterpolatePoints(r.ring,
            least(1, :poi_outline_step_m / greatest(ST_Length(r.ring), 1))))).geom
FROM gen.schools s
JOIN gen.edu_places e ON e.id = s.place_id
CROSS JOIN LATERAL (SELECT ST_ExteriorRing((ST_Dump(e.geom)).geom) AS ring) r
WHERE NOT EXISTS (SELECT 1 FROM gen.campus_buildings b WHERE b.school_id = s.id)
  AND ST_Length(r.ring) > :poi_outline_step_m
UNION ALL
SELECT s.id, s.id, s.trip_ends, true, s.geom
FROM gen.schools s WHERE s.place_id IS NULL;
CREATE INDEX ON gen.school_points USING gist (geom);
