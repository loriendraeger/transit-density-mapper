-- Walk time from each merged stop to both ends of every edge it reaches (NULL = that
-- end is out of reach). The basis for generator times, the spiderweb and the blobs.
DROP TABLE IF EXISTS catch.edge_time CASCADE;
CREATE TABLE catch.edge_time AS
SELECT r.cluster_id, e.id AS edge_id,
       min(r.t) FILTER (WHERE r.vertex = e.source) AS ts,
       min(r.t) FILTER (WHERE r.vertex = e.target) AS tt
FROM catch.reach r
JOIN net.edges e ON r.vertex IN (e.source, e.target)
WHERE e.main
GROUP BY r.cluster_id, e.id;
CREATE INDEX ON catch.edge_time (edge_id);
CREATE INDEX ON catch.edge_time (cluster_id);
