-- Departures per merged stop, route, direction and hour on one representative date per
-- day type, and trips per hour per direction (each route's directions averaged).

-- Representative dates: per day type, the most common set of active services, and
-- the first date with it (unless pipeline.toml names a date).
DROP TABLE IF EXISTS transit.rep_dates;
CREATE TABLE transit.rep_dates AS
WITH sets AS (
    SELECT date, array_agg(service_id ORDER BY service_id) AS services,
           CASE WHEN extract(isodow FROM date) <= 4 THEN 'weekday'
                WHEN extract(isodow FROM date) = 6 THEN 'saturday'
                WHEN extract(isodow FROM date) = 7 THEN 'sunday' END AS day_type
    FROM staging.service_days
    GROUP BY date
),
ranked AS (
    SELECT day_type, services, count(*) AS n_dates, min(date) AS first_date,
           row_number() OVER (PARTITION BY day_type ORDER BY count(*) DESC, min(date)) AS rk
    FROM sets WHERE day_type IS NOT NULL
    GROUP BY day_type, services
),
overrides (day_type, date) AS (
    VALUES ('weekday', nullif(:'weekday_date', '')), ('saturday', nullif(:'saturday_date', '')),
           ('sunday', nullif(:'sunday_date', ''))
)
SELECT r.day_type,
       coalesce(to_date(o.date, 'YYYYMMDD'), r.first_date) AS date,
       r.n_dates
FROM ranked r JOIN overrides o USING (day_type)
WHERE r.rk = 1;

-- Each boardable departure (pickup allowed, and not the trip's last stop) with its
-- GTFS direction (0/1: which way along the route the trip runs) and the bearing to the
-- trip's next stop.
DROP TABLE IF EXISTS transit.departures CASCADE;
CREATE TABLE transit.departures AS
WITH st AS (
    SELECT t.trip_id, t.stop_id, t.dep_s, t.pickup_type,
           lead(t.stop_id) OVER (PARTITION BY t.trip_id ORDER BY t.stop_sequence) AS next_stop
    FROM staging.stop_times t
)
SELECT rd.day_type, pc.cluster_id, st.stop_id, tr.route_id, tr.direction_id, tr.trip_id,
       st.dep_s, st.dep_s / 3600 AS hour,
       degrees(ST_Azimuth(s.geom, n.geom)) AS bearing
FROM transit.rep_dates rd
JOIN staging.service_days sd ON sd.date = rd.date
JOIN staging.trips tr ON tr.service_id = sd.service_id
JOIN st ON st.trip_id = tr.trip_id
JOIN transit.platform_cluster pc ON pc.stop_id = st.stop_id
JOIN staging.stops s ON s.stop_id = st.stop_id
JOIN staging.stops n ON n.stop_id = st.next_stop
WHERE st.pickup_type <> 1;
CREATE INDEX ON transit.departures (cluster_id);

-- The ways a route leaves a merged stop. Usually its two GTFS directions are opposite
-- ways (one per side of the street), but on a loop both can pass the same platform
-- heading the same way; directions whose mean headings here are within
-- :same_way_max_deg are one way (way 0), so a rider there gets both.
DROP TABLE IF EXISTS transit.route_ways;
CREATE TABLE transit.route_ways AS
WITH h AS (
    SELECT cluster_id, route_id, direction_id,
           degrees(atan2(avg(sin(radians(bearing))), avg(cos(radians(bearing))))) AS heading
    FROM transit.departures
    GROUP BY 1, 2, 3
),
same AS (
    SELECT cluster_id, route_id,
           count(*) = 2
           AND abs(mod((max(heading) - min(heading))::numeric + 540, 360) - 180)
               <= :same_way_max_deg AS one_way
    FROM h GROUP BY 1, 2
)
SELECT h.cluster_id, h.route_id, h.direction_id, h.heading,
       CASE WHEN s.one_way THEN 0 ELSE h.direction_id END AS way
FROM h JOIN same s USING (cluster_id, route_id);

-- Departures per merged stop x route x day type x hour (hours >= 24 are after midnight
-- on the same service day).
DROP TABLE IF EXISTS transit.hourly;
CREATE TABLE transit.hourly AS
SELECT cluster_id, route_id, direction_id, day_type, hour, count(*)::int AS departures
FROM transit.departures
GROUP BY 1, 2, 3, 4, 5;

-- Trips per hour by period (departures in the period's windows / the windows' hours).
DROP TABLE IF EXISTS transit.period_windows;
CREATE TABLE transit.period_windows AS
WITH w (period, day_type, bounds) AS (
    VALUES ('peak', 'weekday', string_to_array(:'peak_hours', ',')::int[]),
           ('offpeak', 'weekday', string_to_array(:'offpeak_hours', ',')::int[]),
           ('saturday', 'saturday', string_to_array(:'saturday_hours', ',')::int[]),
           ('sunday', 'sunday', string_to_array(:'sunday_hours', ',')::int[])
)
SELECT period, day_type, bounds[i] AS start_h, bounds[i + 1] AS end_h
FROM w, generate_series(1, array_length(bounds, 1), 2) AS i;

-- Per direction: a rider boards one way, and a merged stop usually holds both sides of
-- the street, so adding the two directions would double-count the service. Each route
-- counts the average of the ways it runs at the stop (in that period); routes then
-- add up (merged-stop frequency combines routes). One side of a one-way pair
-- (Gorham/Johnson) or a line's end only has one direction, so it counts in full and needs
-- no correction (owner, 2026-10-20: average rather than busier direction).
DROP TABLE IF EXISTS transit.period_freq_way;
CREATE TABLE transit.period_freq_way AS
WITH hrs AS (SELECT period, sum(end_h - start_h) AS hours FROM transit.period_windows GROUP BY 1)
SELECT c.cluster_id, w.period, h.route_id, rw.way,
       sum(h.departures)::float8 / hrs.hours AS trips_per_hour
FROM transit.clusters c
JOIN transit.hourly h USING (cluster_id)
JOIN transit.route_ways rw USING (cluster_id, route_id, direction_id)
JOIN transit.period_windows w ON w.day_type = h.day_type
 AND h.hour >= w.start_h AND h.hour < w.end_h
JOIN hrs ON hrs.period = w.period
GROUP BY 1, 2, 3, 4, hrs.hours;

DROP TABLE IF EXISTS transit.period_freq;
CREATE TABLE transit.period_freq AS
SELECT cluster_id, period, route_id, avg(trips_per_hour) AS trips_per_hour
FROM transit.period_freq_way
GROUP BY 1, 2, 3;
