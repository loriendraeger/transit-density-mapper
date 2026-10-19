-- Departures per merged stop, route and hour on one representative date per day type,
-- and whether a stop is one-directional.

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

-- Each boardable departure (pickup allowed, and not the trip's last stop) with the
-- bearing to the trip's next stop.
DROP TABLE IF EXISTS transit.departures CASCADE;
CREATE TABLE transit.departures AS
WITH st AS (
    SELECT t.trip_id, t.stop_id, t.dep_s, t.pickup_type,
           lead(t.stop_id) OVER (PARTITION BY t.trip_id ORDER BY t.stop_sequence) AS next_stop
    FROM staging.stop_times t
)
SELECT rd.day_type, pc.cluster_id, st.stop_id, tr.route_id, tr.trip_id, st.dep_s,
       st.dep_s / 3600 AS hour,
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

-- One-directional stops: every departure heads within :one_way_spread_deg of every
-- other. Measured as the smallest arc containing all bearings (360 minus the largest
-- gap between consecutive bearings around the circle).
DROP TABLE IF EXISTS transit.directionality;
CREATE TABLE transit.directionality AS
WITH b AS (
    SELECT DISTINCT cluster_id, round(bearing)::int AS bearing FROM transit.departures
),
gaps AS (
    SELECT cluster_id, bearing,
           coalesce(lead(bearing) OVER w, first_value(bearing) OVER w + 360) - bearing AS gap
    FROM b
    WINDOW w AS (PARTITION BY cluster_id ORDER BY bearing)
)
SELECT cluster_id, 360 - max(gap) AS spread_deg, 360 - max(gap) <= :one_way_spread_deg AS one_way
FROM gaps GROUP BY cluster_id;

-- Departures per merged stop x route x day type x hour (hours >= 24 are after midnight
-- on the same service day).
DROP TABLE IF EXISTS transit.hourly;
CREATE TABLE transit.hourly AS
SELECT cluster_id, route_id, day_type, hour, count(*)::int AS departures
FROM transit.departures
GROUP BY 1, 2, 3, 4;

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

DROP TABLE IF EXISTS transit.period_freq;
CREATE TABLE transit.period_freq AS
WITH hrs AS (SELECT period, sum(end_h - start_h) AS hours FROM transit.period_windows GROUP BY 1)
SELECT c.cluster_id, w.period, h.route_id,
       sum(h.departures)::float8 / hrs.hours AS trips_per_hour
FROM transit.clusters c
JOIN transit.hourly h USING (cluster_id)
JOIN transit.period_windows w ON w.day_type = h.day_type
 AND h.hour >= w.start_h AND h.hour < w.end_h
JOIN hrs ON hrs.period = w.period
GROUP BY 1, 2, 3, hrs.hours;
