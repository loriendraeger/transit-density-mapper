-- Route lines for the map: every distinct shape a route runs on the representative
-- days, with the route's GTFS color. Drawn under the stops; not interactive.
DROP TABLE IF EXISTS transit.route_lines CASCADE;
CREATE TABLE transit.route_lines AS
SELECT DISTINCT ON (tr.route_id, sh.shape_id)
       tr.route_id, sh.shape_id, r.route_short_name AS name, '#' || r.route_color AS color,
       r.sort_order, sh.geom
FROM transit.rep_dates rd
JOIN staging.service_days sd ON sd.date = rd.date
JOIN staging.trips tr ON tr.service_id = sd.service_id
JOIN staging.shapes sh ON sh.shape_id = tr.shape_id
JOIN staging.routes r ON r.route_id = tr.route_id;
