-- Dasymetric population: each block's population (2020, updated for new housing in
-- Madison; gen.block_pop) goes to the parcels inside it, in proportion to dwelling
-- units, so an apartment building gets more people than the houses next to it. A block with population but no units on any parcel (a dorm block,
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
        SELECT sum((rb.area_m2 * coalesce(rb.levels, :default_levels) / :m2_per_unit)::numeric)::float8
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

-- Each block's population today (2026-10-21): the 2020 count plus the net change in
-- dwelling units since, times the persons per unit of 2020. Only where every unit is on
-- a City of Madison parcel (current unit counts); elsewhere units are estimates tuned
-- to the 2020 census, so the block keeps its 2020 count. Adding the change, rather than
-- scaling, keeps group-quarters residents (dorms) that no unit count includes; a block
-- that lost units loses people, but not below zero. Persons per unit: Madison's 2020
-- population / housing units over those blocks (vacancy included).
DROP TABLE IF EXISTS gen.block_pop;
CREATE TABLE gen.block_pop AS
WITH u AS (
    SELECT pb.geoid,
           sum(pb.units) FILTER (WHERE p.source = 'madison') AS madison,
           sum(pb.units) FILTER (WHERE p.source = 'sco') AS other
    FROM gen.parcel_block pb JOIN staging.parcels p ON p.id = pb.parcel_id
    GROUP BY pb.geoid
),
current AS (
    SELECT b.geoid, b.pop, b.housing, u.madison AS units
    FROM staging.blocks b JOIN u USING (geoid)
    WHERE u.madison > 0 AND u.other IS NULL
),
ppu AS (SELECT sum(pop)::float8 / nullif(sum(housing), 0) AS r FROM current)
SELECT b.geoid, b.pop AS pop2020, c.units AS units_now, b.housing AS housing2020,
       CASE WHEN c.geoid IS NULL THEN b.pop::float8
            ELSE greatest(b.pop + ppu.r * (c.units - b.housing), 0) END AS pop
FROM staging.blocks b
LEFT JOIN current c USING (geoid)
CROSS JOIN ppu;
ALTER TABLE gen.block_pop ADD PRIMARY KEY (geoid);

DROP TABLE IF EXISTS gen.population CASCADE;
CREATE TABLE gen.population AS
WITH totals AS (SELECT geoid, sum(units) AS units FROM gen.parcel_block GROUP BY geoid)
SELECT 'p' || pb.parcel_id AS id, pb.geoid, bp.pop * pb.units / t.units AS pop, pb.pt AS geom
FROM gen.parcel_block pb
JOIN totals t USING (geoid)
JOIN gen.block_pop bp USING (geoid)
WHERE bp.pop > 0
UNION ALL
SELECT 'b' || b.geoid, b.geoid, bp.pop, ST_PointOnSurface(b.geom)
FROM staging.blocks b JOIN gen.block_pop bp USING (geoid)
WHERE bp.pop > 0 AND NOT EXISTS (SELECT 1 FROM gen.parcel_block pb WHERE pb.geoid = b.geoid);
CREATE INDEX ON gen.population USING gist (geom);
