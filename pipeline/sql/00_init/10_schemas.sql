-- Extensions and schemas. Each stage owns one schema:
--   raw      loaded as delivered (transit load)
--   staging  cleaned, reprojected to :crs, typed
--   net      the pedestrian routing graph
--   transit  merged stops and frequencies
--   gen      trip generators (population, jobs, destinations)
--   catch    walk catchments and banded sums
--   export   views the exporters read
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgrouting;
CREATE SCHEMA IF NOT EXISTS raw;
CREATE SCHEMA IF NOT EXISTS staging;
CREATE SCHEMA IF NOT EXISTS net;
CREATE SCHEMA IF NOT EXISTS transit;
CREATE SCHEMA IF NOT EXISTS gen;
CREATE SCHEMA IF NOT EXISTS catch;
CREATE SCHEMA IF NOT EXISTS export;
