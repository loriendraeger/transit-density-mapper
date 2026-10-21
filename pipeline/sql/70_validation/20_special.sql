-- Special stops: riders come for something a walk catchment doesn't measure (a school
-- day, a car parked at a park-and-ride, a flight, a transfer). They're left out of the
-- fit of the score's weights (`transit fit`) but still get a prediction.
DROP TABLE IF EXISTS valid.special_overrides;
CREATE TABLE valid.special_overrides (stop_id text, reason text, note text);
\copy valid.special_overrides FROM 'config/special_stops.csv' CSV HEADER

DROP TABLE IF EXISTS valid.special;
CREATE TABLE valid.special AS
WITH routes AS (
    SELECT cluster_id, count(DISTINCT route_id) AS n FROM transit.period_freq GROUP BY 1
),
auto AS (
    -- Named middle/high schools in OSM, or a stop named for one ("S Gammon at Memorial
    -- High": that school's OSM outline has no name).
    SELECT c.cluster_id, 'school' AS reason FROM transit.clusters c
    WHERE c.name ~* '\m(high|middle)( school)?$'
       OR EXISTS (
        SELECT 1 FROM gen.pois p
        WHERE p.kind = 'school' AND p.name ~* '\m(high|middle)\M'
          AND ST_DWithin(p.geom, c.geom, :special_school_m))
    UNION ALL
    SELECT c.cluster_id, 'campus' FROM transit.clusters c
    WHERE EXISTS (
        SELECT 1 FROM gen.pois p
        WHERE p.kind IN ('university', 'college') AND ST_Intersects(p.geom, c.geom))
    UNION ALL
    SELECT c.cluster_id, 'park_ride' FROM transit.clusters c
    WHERE c.name ~* 'park (and|&) ride'
       OR EXISTS (
        SELECT 1 FROM raw.osm_pois o
        WHERE o.tags ->> 'park_ride' IN ('yes', 'bus')
          AND ST_DWithin(ST_Transform(o.geom, :crs), c.geom, :special_park_ride_m))
    UNION ALL
    SELECT c.cluster_id, 'airport' FROM transit.clusters c WHERE c.name ~* '\mairport\M'
    UNION ALL
    SELECT cluster_id, 'transfer' FROM routes WHERE n >= :special_transfer_min_routes
),
-- Overrides name any platform of a merged stop; reason 'none' clears the stop.
o AS (
    SELECT pc.cluster_id, so.reason
    FROM valid.special_overrides so JOIN transit.platform_cluster pc USING (stop_id)
)
SELECT cluster_id, array_agg(DISTINCT reason ORDER BY reason) AS reasons
FROM (SELECT * FROM auto UNION ALL SELECT * FROM o WHERE reason <> 'none') x
WHERE cluster_id NOT IN (SELECT cluster_id FROM o WHERE reason = 'none')
GROUP BY 1;
