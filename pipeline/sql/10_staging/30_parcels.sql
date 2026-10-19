-- One parcels table from two sources:
--   City of Madison assessor parcels, which carry TotalDwellingUnits;
--   the statewide V12 parcels everywhere else, which carry no unit count (units are
--   estimated per block in 40_generators/10_population.sql).

DROP TABLE IF EXISTS staging.parcels CASCADE;
CREATE TABLE staging.parcels AS
SELECT
    'madison'::text AS source,
    parcel AS parcel_id,
    propertyclass AS propclass,
    propertyuse AS propuse,
    coalesce(totaldwellingunits, 0)::int AS units,
    coalesce(currentimpr, 0)::float8 AS impvalue,
    ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_Transform(geom, :crs)), 3))
        ::geometry(MultiPolygon, :crs) AS geom
FROM raw.madison_parcels
UNION ALL
SELECT
    'sco',
    coalesce(parcelid, stateid),
    propclass,
    NULL,
    NULL,
    coalesce(impvalue, 0),
    ST_Multi(ST_CollectionExtract(ST_MakeValid(geom), 3))::geometry(MultiPolygon, :crs)
FROM raw.parcels
WHERE coalesce(placename, '') <> 'CITY OF MADISON';
DELETE FROM staging.parcels WHERE ST_IsEmpty(geom);
ALTER TABLE staging.parcels ADD COLUMN id serial PRIMARY KEY;
-- A point inside each parcel stands in for where its people live.
ALTER TABLE staging.parcels ADD COLUMN pt geometry(Point, :crs);
UPDATE staging.parcels SET pt = ST_PointOnSurface(geom);
CREATE INDEX ON staging.parcels USING gist (geom);
CREATE INDEX ON staging.parcels USING gist (pt);
