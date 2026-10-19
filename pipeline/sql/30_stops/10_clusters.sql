-- Merged stops (clusters from `transit cluster`, stops.py): location, name, members.

DROP TABLE IF EXISTS transit.clusters CASCADE;
CREATE TABLE transit.clusters AS
WITH busy AS (
    -- Name a cluster after its busiest platform (BRT platforms: their station's name).
    SELECT p.cluster_id, coalesce(ps.stop_name, s.stop_name) AS name,
           row_number() OVER (PARTITION BY p.cluster_id
                              ORDER BY count(t.*) DESC, p.stop_id) AS rk
    FROM transit.platform_cluster p
    JOIN staging.stops s USING (stop_id)
    LEFT JOIN staging.stops ps ON ps.stop_id = s.parent_station
    LEFT JOIN staging.stop_times t ON t.stop_id = p.stop_id
    GROUP BY p.cluster_id, p.stop_id, ps.stop_name, s.stop_name
)
SELECT p.cluster_id,
       b.name,
       count(*)::int AS n_platforms,
       array_agg(p.stop_id ORDER BY p.stop_id) AS stop_ids,
       array_agg(DISTINCT s.stop_code ORDER BY s.stop_code) AS stop_codes,
       ST_Centroid(ST_Collect(s.geom))::geometry(Point, :crs) AS geom
FROM transit.platform_cluster p
JOIN staging.stops s USING (stop_id)
JOIN busy b ON b.cluster_id = p.cluster_id AND b.rk = 1
GROUP BY p.cluster_id, b.name;
ALTER TABLE transit.clusters ADD PRIMARY KEY (cluster_id);
CREATE INDEX ON transit.clusters USING gist (geom);
