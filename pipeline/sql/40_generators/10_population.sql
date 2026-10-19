-- Dasymetric population: each 2020 block's population goes to the parcels inside it, in
-- proportion to dwelling units, so an apartment building gets more people than the
-- houses next to it. A block with population but no units on any parcel (a dorm block,
-- a block whose parcels didn't load) keeps its people at a point inside the block.
--
-- Units: City of Madison parcels have TotalDwellingUnits. Elsewhere they're estimated
-- (pipeline.toml [generators]): residential buildings from OSM, else one per
-- residential parcel.

-- Estimated units for parcels without a count. Condominiums are stacks of parcels
-- with identical polygons (one per unit); a stack is estimated once, as the larger of
-- its residential parcel count and its buildings' estimate, all on its first parcel.
DROP TABLE IF EXISTS gen.parcel_units;
CREATE TABLE gen.parcel_units AS
WITH sco AS (
    SELECT id, propclass, impvalue, geom, md5(ST_AsBinary(geom)) AS gkey
    FROM staging.parcels WHERE source = 'sco'
),
stacks AS (
    SELECT gkey, min(id) AS id,
           count(*) FILTER (WHERE propclass LIKE '%1%' AND impvalue > 0) AS res_parcels
    FROM sco GROUP BY gkey
),
est AS (
    SELECT st.id, greatest(st.res_parcels, coalesce(b.multi_units, 0)) AS units
    FROM stacks st
    JOIN sco p ON p.id = st.id
    LEFT JOIN LATERAL (
        -- Multi-unit residential buildings on the parcel: floor area / m2 per unit.
        SELECT sum(rb.area_m2 * coalesce(rb.levels, :default_levels) / :m2_per_unit)
               AS multi_units
        FROM staging.res_buildings rb
        WHERE rb.building IN ('apartments', 'dormitory', 'residential', 'terrace')
          AND (rb.building <> 'residential' OR rb.area_m2 > 400)
          AND rb.geom && p.geom
          AND ST_Contains(p.geom, ST_PointOnSurface(rb.geom))
    ) b ON true
)
SELECT p.id,
       CASE WHEN p.source = 'madison' THEN p.units::float8 ELSE coalesce(est.units, 0) END
           AS units
FROM staging.parcels p
LEFT JOIN est ON est.id = p.id;

-- Parcels inside each block (by the parcel's interior point).
DROP TABLE IF EXISTS gen.parcel_block;
CREATE TABLE gen.parcel_block AS
SELECT p.id AS parcel_id, b.geoid, u.units, p.pt
FROM staging.parcels p
JOIN gen.parcel_units u ON u.id = p.id
JOIN staging.blocks b ON ST_Intersects(b.geom, p.pt)
WHERE u.units > 0;

DROP TABLE IF EXISTS gen.population CASCADE;
CREATE TABLE gen.population AS
WITH totals AS (SELECT geoid, sum(units) AS units FROM gen.parcel_block GROUP BY geoid)
SELECT 'p' || pb.parcel_id AS id, pb.geoid, b.pop * pb.units / t.units AS pop, pb.pt AS geom
FROM gen.parcel_block pb
JOIN totals t USING (geoid)
JOIN staging.blocks b USING (geoid)
WHERE b.pop > 0
UNION ALL
SELECT 'b' || b.geoid, b.geoid, b.pop::float8, ST_PointOnSurface(b.geom)
FROM staging.blocks b
WHERE b.pop > 0 AND NOT EXISTS (SELECT 1 FROM gen.parcel_block pb WHERE pb.geoid = b.geoid);
CREATE INDEX ON gen.population USING gist (geom);
