-- Every generator point -> its nearest walkable edge (main network; side copies of
-- arterials by their offset geometry, so a house snaps to its own side). Walk time to a
-- point = time to the edge point + straight-line access distance / speed.

DROP TABLE IF EXISTS gen.points CASCADE;
CREATE TABLE gen.points AS
SELECT 'pop'::text AS kind, id AS gen_id, NULL::text AS category, pop AS value, geom
FROM gen.population
UNION ALL
SELECT 'jobs', id, NULL, jobs, geom FROM gen.jobs
UNION ALL
SELECT 'shopjobs', 's' || geoid, NULL, shop_jobs, geom FROM gen.jobs WHERE shop_jobs > 0
UNION ALL
SELECT 'poi', pp.poi_id, p.category, p.weight, pp.geom
FROM gen.poi_points pp JOIN gen.pois p ON p.id = pp.poi_id
UNION ALL
-- School trip ends a day (35_schools.sql).
SELECT 'school', gen_id, NULL, value, geom FROM gen.school_points;
ALTER TABLE gen.points ADD COLUMN pid serial PRIMARY KEY;

DROP TABLE IF EXISTS gen.snap;
CREATE TABLE gen.snap AS
SELECT g.pid, e.id AS edge_id, ST_LineLocatePoint(e.geom_snap, g.geom) AS frac, e.dist
FROM gen.points g
CROSS JOIN LATERAL (
    SELECT n.id, n.geom_snap, ST_Distance(n.geom_snap, g.geom) AS dist
    FROM net.edges n
    WHERE n.main AND n.kind <> 'cross'
      AND ST_DWithin(n.geom_snap, g.geom, :snap_max_m)
    ORDER BY n.geom_snap <-> g.geom
    LIMIT 1
) e;
CREATE INDEX ON gen.snap (edge_id);
