# AGENTS.md

Guidance for AI coding agents (and humans) working in this repo.

## Project

**Goal: show how well each Madison Metro stop is placed relative to the things that
generate transit trips** (people, jobs, and destinations) and how often buses actually
serve it.

Two views on one static site:

1. **Map.** Trip generators (population density, job density, destinations), transit
   stops, and each stop's **walk catchment** drawn as a blob that fades as walking time
   grows.
2. **Stop Analysis tab.** One entry per (merged) stop: frequency through the day for each
   service period, and a **catchment score** for the trip generators within walking
   distance.

Users can tinker: the **walk-time cutoff** (5–20 min slider), the **weights** that make up
the score, the **decay curve**, and how map layers look. Everything the user can adjust
is computed in the browser from precomputed, compact data.

Two halves, as in `../public-private-shore`:

1. **Data pipeline** (local, run by hand): raw public datasets go in, and map tiles plus
   per-stop stats come out.
2. **Static site** (GitHub Pages, client-only): renders the committed outputs.

**Status (2026-10-19):** ideation done, requirements decided (see below). Nothing built
yet. Next: [Milestone 1](#milestones).

### Spirit of the project

A **for-fun learning project**. The owner is interested in GIS and transit.

- Prefer **standard, industry-typical GIS and transit-analysis tools and practices** over
  clever shortcuts. Learning the "real" way is the point.
- Overengineering is fine when it's interesting. Ceremony that isn't fun is not.
- When introducing a GIS or transit concept (CRS choice, dasymetric mapping, isochrones,
  headway vs. frequency, etc.), briefly explain *why*.
- Testing: **some, not a lot.** See [Testing](#testing).
- When a design question comes up, propose options with a recommendation; don't silently
  pick. Record decisions in this file with the date.
- **Git:** commit directly on `main` as you go, in small logical commits. **Never push**;
  the owner pushes.

## Decisions (2026-10-19)

| Topic | Decision |
|---|---|
| Study area | **Madison Metro service area**: every stop in the GTFS feed, plus a walking buffer (≥ 20 min walk, ~2 km) for census, parcel, and OSM data. Spans Madison, Middleton, Fitchburg, Verona, Monona, and others. |
| Stack | **Reuse `../public-private-shore`**, plus **pgRouting** for the walk network. |
| Stop merging | **Use GTFS `parent_station`** where Metro provides it. Fall back to distance clustering only if needed (see [Stops](#stops)). Merged location = midpoint/centroid of members. |
| Service periods | **Weekday peak**, **weekday off-peak**, **Saturday**, **Sunday/holiday**, and a **weighted aggregate** of those. |
| Crossing penalty | **Barrier-style**: major roads can be crossed only at mapped crossings; signalized crossings add an expected wait. See [Walk network](#walk-network). |
| Population | **2020 Census blocks, split among residential parcels by dwelling units** (dasymetric). |
| Jobs | **LEHD LODES WAC** (jobs by workplace, census block level). |
| Destinations | **OSM POIs**, weighted by category. |
| Score | **Walk-time decay, tunable**: closer things count more, with a hard cutoff at the slider value. |
| Merged-stop frequency | **Combine all routes** at a merged stop. Show the per-route breakdown too; we may refine this later. |
| Licenses | **Same split as the sibling**: code GPL-3.0-or-later (`LICENSE`), docs CC BY-SA 4.0 (`LICENSE-DOCS`), outputs ODbL 1.0 with upstream attributions (`LICENSE-DATA`; required by OSM). |

## Tech stack

Copied from `../public-private-shore` unless noted. Look there first for working
patterns (Makefile, Docker Compose, SQL runner, PMTiles export, Vite config, deploy
workflow) and adapt them instead of reinventing them.

| Layer | Choice |
|---|---|
| Pipeline language | Python 3.12, managed with **uv** |
| Lint/format | **ruff** |
| Tests | **pytest** (light) |
| Spatial database | **PostGIS + pgRouting** (Docker) — *new: pgRouting* |
| Transforms | **Plain numbered SQL files** run via `psql` |
| Orchestration | **Makefile** |
| Geo CLI tools | GDAL/OGR (`ogr2ogr`), `osmium-tool`, **tippecanoe**, `pmtiles` CLI |
| Python geo libs | GeoPandas, Shapely 2, pyogrio, pyproj, psycopg 3 (when SQL is awkward) |
| GTFS handling | Load GTFS text files into PostGIS (`gtfs` schema) and compute frequencies in SQL. A Python GTFS library (e.g. `gtfs-kit`) is allowed for validation/recon. |
| Reproducibility | **Docker Compose**: PostGIS/pgRouting + a pipeline container with GDAL/tippecanoe/osmium/uv pinned |
| Tile format | **PMTiles** (no tile server) |
| Frontend | **Vite + Solid + TypeScript** |
| Frontend lint/format | **ESLint** (typescript-eslint, eslint-plugin-solid) + **Prettier** |
| Map library | **MapLibre GL JS** + `pmtiles` protocol |
| Charts | **Observable Plot** (frequency-by-hour charts, score breakdowns) |
| Tables | **TanStack Table** (`@tanstack/solid-table`) for the Stop Analysis tab |
| Basemap | **Protomaps** PMTiles extract clipped to the study area |
| Hosting | **GitHub Pages**, deployed by GitHub Actions |

## Data sources

Exact URLs, layer names, and field names **must be verified when implementing**. Record
them in `config/sources.toml` with license/attribution and retrieval date. Don't
hardcode them in scripts.

| Source | Used for | Notes |
|---|---|---|
| **Madison Metro GTFS**: http://transitdata.cityofmadison.com/GTFS/ | Stops, routes, trips, stop times, calendars | License: https://www.cityofmadison.com/metro/business/information-for-developers/developer-license-agreement-and-terms-of-use. Read it during recon and record its attribution/disclaimer requirements. Check whether `parent_station` is populated. |
| **OpenStreetMap**: Geofabrik Wisconsin extract, filtered with `osmium` | Pedestrian network (sidewalks, crossings, paths, streets, signals), destination POIs | ODbL; attribution required |
| **2020 Decennial Census** (P1 population, H1 housing units) + **TIGER/Line 2020 blocks** | Population per block | Blocks, not tracts. 2020 decennial is published at block level |
| **LEHD LODES** (latest LODES version, Wisconsin, WAC, all jobs) | Jobs per census block | Check which LODES version uses 2020 block geography |
| **Parcels**: Wisconsin Statewide Parcel Map (V-series) and/or Dane County LIO; **City of Madison assessor data** for dwelling units | Placing population inside blocks | The statewide parcels may not have a unit count. Madison assessor data likely does; suburbs may need a proxy (property class + building area/value). Verify during recon. |
| **Municipal boundaries** (LTSB or Dane County) | Labels, study-area context | Optional |

## Architecture

```
download ──► load ──► transform (SQL) ──► walk network ──► catchments ──► export ──► tiles ──► site
 (files)   (ogr2ogr,  (raw → staging)     (pgRouting       (per-stop       (JSON/      (PMTiles)  (Vite,
           GTFS CSV,                       graph w/         walk times,     GeoJSON)               GH Pages)
           osmium)                         crossings)       bands, sums)
```

Same file/database hybrid as public-private-shore: raw downloads are **files**, analysis
is **PostGIS SQL** (plus pgRouting), and products are exported back to **files**.

### Proposed repo layout

```
.
├── AGENTS.md                 # this file (CLAUDE.md imports it)
├── README.md
├── docs/ARCHITECTURE.md      # how the code fits together; keep current
├── Makefile
├── docker-compose.yml        # db (PostGIS + pgRouting), pipeline (tools)
├── config/                   # ALL tunable pipeline knobs
│   ├── pipeline.toml         # study area buffer, CRS, walk speed, crossing waits,
│   │                         # service periods, max walk time, band size
│   ├── sources.toml          # URLs, licenses, retrieval dates
│   ├── stop_merge_overrides.csv   # hand fixes to stop grouping
│   ├── poi_categories.csv    # OSM tag → category → default weight
│   └── road_classes.csv      # OSM highway class → crosses-as-barrier?, signal wait
├── pipeline/
│   ├── pyproject.toml        # uv project; console script (e.g. `transit`)
│   ├── src/transit/          # cli, config, download, load, sqlrun, export, stats
│   └── sql/
│       ├── 00_init/          # extensions (postgis, pgrouting), schemas
│       ├── 10_staging/       # gtfs, osm network, blocks, parcels, lodes, pois
│       ├── 20_network/       # build pedestrian graph, crossings, costs
│       ├── 30_stops/         # merge stops, frequencies by period/hour
│       ├── 40_generators/    # dasymetric population, jobs, POIs → network nodes
│       └── 50_catchments/    # per-stop walk times, bands, banded sums
├── data/                     # raw/ and build/ (gitignored)
└── site/                     # Vite + Solid app; public/data/ is committed
```

CRS: store in EPSG:4326 for export; do analysis in a meter-based projected CRS
(**EPSG:3071**, Wisconsin Transverse Mercator, same as the sibling project).

## Methods

### Stops

- Load GTFS `stops.txt`. If `parent_station` is populated, a merged stop = a parent
  station and its child platforms.
- **Fallback** where it isn't (verify in recon): cluster platforms that share a
  normalized stop name/intersection and lie within a tunable distance (start ~75 m).
  `config/stop_merge_overrides.csv` forces merges and splits.
- Merged stop location = centroid of member platforms.
- Keep the member platforms. Frequency is reported for the merged stop and broken down
  by route and direction.

### Frequency

- Pick a **representative date** for each day type from `calendar.txt` /
  `calendar_dates.txt` (a normal week, no holidays). Record the chosen dates in the
  outputs.
- Count **departures per hour** for each merged stop × route × direction × day type.
- **Periods** (windows in `pipeline.toml`, e.g. peak 6–9 and 15–18 on weekdays):
  weekday peak, weekday off-peak, Saturday, Sunday/holiday. Report trips/hour and
  average headway for each.
- **Weighted aggregate**: a weighted combination of the four periods (default weights
  roughly by hours of service × days per week; tunable on the site).
- A merged stop's frequency **combines all routes** (decided). This can overstate service
  when routes go to different places, so show per-route numbers too. Revisit later if it
  looks misleading, e.g. by counting only distinct departures in each direction.

### Walk network

- Build a pedestrian graph from OSM: `footway` (sidewalks, crossings), `path`,
  `pedestrian`, `steps`, `living_street`, and walkable street centerlines (residential,
  service, unclassified, tertiary) where separate sidewalks aren't mapped. Exclude
  motorways and `foot=no`.
- Edge cost = length ÷ walk speed (default 1.3 m/s, about 4.7 km/h; tunable).
- **Barrier-style crossings** (decided):
  - Major roads (classes listed in `config/road_classes.csv`, e.g. trunk, primary,
    secondary) **cannot be crossed except at mapped crossings** (`highway=crossing`
    nodes, `footway=crossing` ways, or signalized intersections). Routes detour to a
    crosswalk.
  - Crossings at `crossing=traffic_signals` / `highway=traffic_signals` add an expected
    **signal wait** (about half the cycle; default by road class, e.g. ~30–45 s for
    arterials).
  - Unsignalized marked crossings of major roads may add a smaller wait (tunable,
    default 0).
- **Verify in recon**: how complete Madison's sidewalk and crossing mapping is. Where
  sidewalks aren't mapped separately, people walk along a major road's centerline in
  the graph, and crossings have to be modeled at intersections. Choose the approach
  after looking at the data.
- Connect each merged stop (and its platforms) to the nearest graph edges.

### Catchments

- For each merged stop, run **`pgr_drivingDistance`** with a cutoff of 20 min (the
  slider max) to get the walk time to every reachable node.
- **Blob**: group reached edges into **1-minute bands** and turn each band into a polygon
  (buffer the reached edges, or concave hull). Export the bands. The site shows bands
  ≤ slider and fades opacity as time grows.
- **Banded sums**: for each stop × band, total population, jobs, and POIs by category.
  This keeps the site's data small, and the site can still apply any cutoff or decay
  curve.

### Trip generators

- **Population (dasymetric)**: 2020 block population is split among the residential
  parcels in that block in proportion to their dwelling units. Each parcel's share goes
  to a point (parcel centroid or building), and that point snaps to the walk network.
  Blocks with population but no residential parcels keep their population at the block
  centroid. Explain this to users on the site.
- **Jobs**: LODES WAC block totals at block centroids (or spread over non-residential
  parcels in the block later if that's worth doing). Optional breakdown by industry
  (CNS codes) for later.
- **Destinations**: OSM POIs mapped to categories (bars, restaurants, music venues,
  theaters, museums, zoo, botanical gardens, parks, libraries, grocery, schools,
  universities, hospitals, stadiums/arenas) in `config/poi_categories.csv`, with default
  weights the user can change. Polygons (zoo, parks, campus) use their entrances where
  mapped, otherwise the point nearest the network.
- Each generator point's walk time = time to the nearest network node + straight-line
  access time from the node.

### Scoring (in the browser)

```
score(stop) = Σ_bands decay(t) × ( w_pop·pop_t + w_jobs·jobs_t + Σ_cat w_cat·poi_cat,t )
```

for bands t ≤ slider cutoff.

- **Decay curves** the user can pick from: none (hard cutoff), linear, exponential, or
  logistic, each with a tunable parameter.
- Population, jobs, and POI points are in different units, so normalize each component
  (e.g. as a share of the study-area max or a percentile) before weighting. Pick the
  method during milestone 5 and explain it on the site.
- Optional combined "transit usefulness" view: score × frequency (selected period).
- A person or job inside several catchments counts toward each of those stops. Note this
  on the site.

## Frontend

- **Map tab**: layers for population density, job density, POIs, stops (sized/colored by
  frequency for the selected period), and the catchment blob for the selected or hovered
  stop. Sliders: walk time (5–20 min). Layer style controls (opacity, color ramp,
  on/off).
- **Stop Analysis tab**: a sortable table of merged stops (score, components, frequency
  for each period). Each stop has a detail view with a departures-per-hour chart for each
  day type, a per-route breakdown, and a score breakdown.
- **Settings panel** shared by both tabs: weights, decay curve, walk cutoff, period
  weights. Keep them in the URL so a view can be shared.
- Attribution footer: Madison Metro (per the license terms), OSM, Census/LEHD,
  parcel sources.

## Testing

Light:

- **Unit**: stop-merge clustering, decay functions (TS), POI tag → category mapping.
- **Data validation** (pytest against PostGIS):
  - Dasymetric population sums back to each block's census total.
  - Every GTFS stop belongs to exactly one merged stop.
  - Frequencies for a well-known stop are close to the published timetable.
  - A walk catchment for a known stop looks right (checked on the map; one numeric
    sanity check, e.g. 10-min reachable area in a plausible range).
- No frontend test suite unless something gets complicated.

## Milestones

1. **Data recon.** Download and inspect every source. Record findings in
   `config/sources.toml`. Answer: is `parent_station` populated? Is the Metro license OK
   for a public GitHub Pages site? How complete are Madison's OSM sidewalks and
   crossings? Where can we get dwelling units outside Madison?
2. **Thin slice: one stop.** E Washington Ave & North St, end to end: GTFS → merged stop
   → frequency → walk catchment with crossings → bands → blob on a map, locally.
3. **All stops + frequency.** Every merged stop, all periods, overrides CSV, per-route
   breakdown.
4. **Trip generators.** Dasymetric population, LODES jobs, OSM POIs, snapped to the
   network. Banded sums per stop.
5. **Scoring + Map tab.** Weights, decay, slider, and layer styling in the browser.
6. **Stop Analysis tab.** Table, per-stop detail, charts.
7. **Ship.** GitHub Actions deploy to Pages, attribution, licenses.
8. **Explain and polish.** Methodology page, performance, mobile.

## Open questions

- Weekday peak windows and aggregate weights: defaults to choose after looking at
  Metro's actual service span.
- Jobs: is spreading LODES jobs onto non-residential parcels worth it?
