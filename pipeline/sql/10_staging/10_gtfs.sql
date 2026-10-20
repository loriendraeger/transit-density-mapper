-- GTFS: typed copies of the raw text tables, stops reprojected to :crs.

DROP TABLE IF EXISTS staging.stops CASCADE;
CREATE TABLE staging.stops AS
SELECT
    stop_id,
    stop_code,
    stop_name,
    nullif(location_type, '')::int AS location_type,
    nullif(parent_station, '') AS parent_station,
    nullif(cardinal_direction, '')::int AS cardinal_direction,
    primary_street,
    cross_location,
    jurisdiction_id,
    ST_Transform(ST_SetSRID(ST_MakePoint(stop_lon::float8, stop_lat::float8), 4326), :crs)
        AS geom
FROM raw.gtfs_stops;
ALTER TABLE staging.stops ADD PRIMARY KEY (stop_id);
CREATE INDEX ON staging.stops USING gist (geom);

DROP TABLE IF EXISTS staging.routes;
CREATE TABLE staging.routes AS
SELECT route_id, route_short_name, route_long_name, route_desc, route_color,
       route_text_color, route_service_name, nullif(route_sort_order, '')::int AS sort_order
FROM raw.gtfs_routes;

DROP TABLE IF EXISTS staging.trips;
CREATE TABLE staging.trips AS
SELECT trip_id, route_id, service_id, trip_headsign, nullif(direction_id, '')::int AS direction_id,
       shape_id
FROM raw.gtfs_trips;
ALTER TABLE staging.trips ADD PRIMARY KEY (trip_id);

-- Times can pass 24:00:00 (service after midnight belongs to the previous day), so keep
-- them as seconds since midnight rather than a time type.
DROP TABLE IF EXISTS staging.stop_times;
CREATE TABLE staging.stop_times AS
SELECT
    trip_id,
    stop_id,
    stop_sequence::int AS stop_sequence,
    split_part(departure_time, ':', 1)::int * 3600
        + split_part(departure_time, ':', 2)::int * 60
        + split_part(departure_time, ':', 3)::int AS dep_s,
    coalesce(nullif(pickup_type, '')::int, 0) AS pickup_type,
    coalesce(nullif(drop_off_type, '')::int, 0) AS drop_off_type
FROM raw.gtfs_stop_times;
CREATE INDEX ON staging.stop_times (trip_id, stop_sequence);
CREATE INDEX ON staging.stop_times (stop_id);

-- Route shapes as lines (for drawing routes on the map).
DROP TABLE IF EXISTS staging.shapes;
CREATE TABLE staging.shapes AS
SELECT shape_id,
       ST_Transform(ST_MakeLine(ST_SetSRID(ST_MakePoint(shape_pt_lon::float8,
                                                        shape_pt_lat::float8), 4326)
                                ORDER BY shape_pt_sequence::int), :crs)
           ::geometry(LineString, :crs) AS geom
FROM raw.gtfs_shapes
GROUP BY shape_id;
ALTER TABLE staging.shapes ADD PRIMARY KEY (shape_id);

DROP TABLE IF EXISTS staging.calendar;
CREATE TABLE staging.calendar AS
SELECT service_id, monday::int = 1 AS mon, tuesday::int = 1 AS tue, wednesday::int = 1 AS wed,
       thursday::int = 1 AS thu, friday::int = 1 AS fri, saturday::int = 1 AS sat,
       sunday::int = 1 AS sun, to_date(start_date, 'YYYYMMDD') AS start_date,
       to_date(end_date, 'YYYYMMDD') AS end_date
FROM raw.gtfs_calendar;

DROP TABLE IF EXISTS staging.calendar_dates;
CREATE TABLE staging.calendar_dates AS
SELECT service_id, to_date(date, 'YYYYMMDD') AS date, exception_type::int AS exception_type
FROM raw.gtfs_calendar_dates;

-- Active service_ids for every date the feed covers.
DROP TABLE IF EXISTS staging.service_days;
CREATE TABLE staging.service_days AS
WITH dates AS (
    SELECT d::date AS date
    FROM generate_series((SELECT min(start_date) FROM staging.calendar),
                         (SELECT max(end_date) FROM staging.calendar), '1 day') AS d
),
regular AS (
    SELECT d.date, c.service_id
    FROM dates d
    JOIN staging.calendar c ON d.date BETWEEN c.start_date AND c.end_date
     AND CASE extract(isodow FROM d.date)
             WHEN 1 THEN c.mon WHEN 2 THEN c.tue WHEN 3 THEN c.wed WHEN 4 THEN c.thu
             WHEN 5 THEN c.fri WHEN 6 THEN c.sat ELSE c.sun END
)
SELECT date, service_id FROM regular
WHERE NOT EXISTS (SELECT 1 FROM staging.calendar_dates x
                  WHERE x.date = regular.date AND x.service_id = regular.service_id
                    AND x.exception_type = 2)
UNION
SELECT date, service_id FROM staging.calendar_dates WHERE exception_type = 1;
