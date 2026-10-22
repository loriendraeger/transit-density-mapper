# AGENTS.md

Guidance for AI coding agents (and humans) working in this repo.

## Project

**Goal: show each Madison Metro stop's ridership potential and transit density**
(owner's focus, 2026-10-21): the trip generators within a short walk (homes, jobs, other
destinations), how often buses serve the stop, and how its observed boardings compare
with what its catchment and service predict.

Two views on one static site:

1. **Map.** Trip generators (population or job density, destinations), transit stops,
   and the selected stop's **walk catchment**: a spiderweb of walkable paths and a blob
   that fades as walking time grows.
2. **Stop analysis tab.** One row per (merged) stop: frequency through the day for each
   service period, and a **catchment score** for the trip generators within walking
   distance. Each stop has a detail view.

Users can tinker with few things (owner 2026-10-21: "very reasonable defaults, fewer
sliders"): the **walk limit** and **half-life** (exponential decay only), the three score
**weights**, two presets that set all five (**Default assumption** and **Best fit**), the
**service period**, the stop coloring and how map layers look. Destination categories
and period weights are fixed in config.
Everything adjustable is computed in the browser from precomputed data.

Two halves, as in `../public-private-shore`:

1. **Data pipeline** (local, run by hand): raw public datasets go in, and map tiles plus
   per-stop data come out.
2. **Static site** (GitHub Pages, client-only): renders the pipeline's outputs.

**Status (end of 2026-10-19):** milestones 1–6 done. Built in one long session: an
autonomous first pass, then a day of owner review and changes (layout, hexes, route
lines, one-way display, catchment file format, pipeline speed; all recorded below). The
owner has looked at the site and tuned some weights but hasn't signed off on the data.
The full pipeline runs from `make` (~2.5 min from scratch after downloads; ~25 s after a
destination-weight change; ~1 s when nothing changed), and the site runs locally
(`make site`). Next steps: [Open questions](#open-questions). `site/public/data/` is **gitignored until the owner is happy with it**,
so the deploy workflow exists but would publish a site with no data. See
[Milestones](#milestones) and [Open questions](#open-questions).

**Code architecture:** see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): what each
piece does and where to change things. Keep it current as code changes.

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

## Decisions

| Topic | Decision |
|---|---|
| Study area (2026-10-19) | **Madison Metro service area**: every stop in the GTFS feed plus ~3 km (`pipeline.toml [study_area]`). Spans Madison, Middleton, Fitchburg, Verona, Monona, Sun Prairie and others. |
| Stack (2026-10-19) | **Reuse `../public-private-shore`**, plus **pgRouting** for the walk network. |
| Stop merging (2026-10-19) | GTFS `parent_station` turned out to cover only the 19 BRT stations, so: BRT platforms merge with their station, and everything else merges by **complete-linkage clustering** with a **110 m** maximum diameter (`stops.py`). `config/stop_merge_overrides.csv` forces merges/splits. Merged location = centroid of the platforms. |
| Service periods (2026-10-19) | **Weekday peak** (6–9, 15–18), **weekday off-peak** (9–15, 18–22), **Saturday** (8–20), **Sunday/holiday** (8–20), and a **weighted week** (default weights = hours per week each period stands for: 30/50/12/12). Weekday = Mon–Thu with UW in session (most common pattern). Friday is its own GTFS service but differs only by 6 late-night campus trips (routes 80/81/82, after 10 pm), outside every period window. |
| Merged-stop frequency (2026-10-19) | **Combine all routes**, counting only departures you can board. Per-route numbers are shown too. |
| Per-direction frequency (2026-10-20; replaces the 2026-10-19 ×2 rule for one-way stops) | A rider boards one way, so frequency is **per direction**: each route counts the **average of the ways it runs** at the merged stop (owner's choice over the busier direction), then routes add up. Ways = GTFS `direction_id`, except that a route's two directions whose headings at the stop (bearing to the next stop) are within `same_way_max_deg` (90°) are one way and add up (loops pass one platform both ways). One side of a couplet or a terminus has one way and counts in full, so no correction factor. |
| Crossing penalty (2026-10-19, confirmed after review) | **Barrier-style**, implemented as the **corner model** (see [Walk network](#walk-network)): trunk/primary/secondary roads can only be crossed at signals or marked crossings, costing the expected wait plus the walk across. **Unmarked crossings of them stay forbidden** (owner kept this over Wisconsin's every-intersection-is-a-crosswalk rule). Waits per class in `config/road_classes.csv`. |
| Population (2026-10-19; revised 2026-10-21) | **2020 Census blocks, split among parcels by dwelling units** (dasymetric). Madison parcels have current `TotalDwellingUnits`; **Madison blocks add the net change in units since 2020 × 2.08 persons per unit** (Madison's 2020 ratio), so post-2020 apartments count (+28k people; 36 blocks empty in 2020 now populated). Elsewhere units are estimated and the 2020 count stands. CV R² 0.152 → 0.160 (default), 0.188 → 0.200 (best fit). |
| No car-ownership weighting (2026-10-21) | **Owner's call: measure where people live and go irrespective of mode.** No zero-car households or other "likely rider" adjustments: a dense place where everyone drives is an opportunity, not low potential. (The critique suggested ACS zero-car households as a strong ridership predictor; deliberately not used.) |
| Jobs (2026-10-19) | **LEHD LODES 8 WAC, 2023**, at a point inside each block (lumping big suburban blocks is accepted). |
| Destinations (2026-10-19; revised 2026-10-21) | **Other destinations** = OSM POIs (per-kind weights in `config/poi_categories.csv` rank places *within* a category) with each category group's **total set by its share of trips in the 2022 NHTS** (urban trips; `config/trip_purposes.csv`, `config/destination_groups.csv`), plus **retail and health-care jobs** (LODES CNS07+CNS16) at a fitted points-per-job rate, since OSM can't tell a supermarket from a corner store. Both beat the hand weights in cross-validation against boardings (20/20 splits); jobs by industry *replacing* OSM did worse. No category sliders. |
| Score (2026-10-19; revised 2026-10-21) | Three components, **Homes** (residents), **Jobs**, **Other destinations**, each summed with the **decay weight** of its walk time, **normalized 0–100 against the best stop**, then weight-averaged. **Fixed**: 10 min walk, exponential decay with a **4 min half-life** (owner's pick: the fit preferred 1–2 min by a small margin; 4 min keeps the 10-minute walk meaningful). Default weights fit to ridership (homes 5, jobs 0.5, other destinations 4). |
| Blob rendering (2026-10-19) | Cumulative 1-minute bands stacked with per-band opacities solved so the **blob's opacity at time t follows the score's decay curve**. |
| Licenses (2026-10-19) | **Same split as the sibling**: code GPL-3.0-or-later (`LICENSE`), docs CC BY-SA 4.0 (`LICENSE-DOCS`), outputs ODbL 1.0 with upstream attributions (`LICENSE-DATA`; required by OSM). |
| Presets (2026-10-21) | Walk-limit and half-life sliders came back with two buttons: **Default assumption** (`[score]`: 10 min, 4 min half-life, weights fit there; the app's defaults) and **Best fit** (walk 5–20 × half-life 1–10 searched; weights refit; other destinations keep the default fit's points per shop job). Best fit 2026-10-21: 5 min walk, 3 min half-life, homes 3.5, jobs 0, other destinations 5; CV R² 0.188 vs. 0.152. |
| Transit connections (2026-10-21) | A **fourth score term**: jobs + other destinations reachable by **transit** (R5 via r5py; walk + ride + transfers), **gravity**: each discounted by 0.5^(t / 20 min), nothing past **60 min**; weekday **7–9 am**, every departure minute, **10th-percentile** travel time (owner: planned trips shouldn't pay half the headway; R5/Conveyal practice; the fit preferred p10 > p25 > median). Jobs and destinations reached fold into one term at the fitted ratio (currently all jobs: destinations reached add nothing once jobs are in). Reverse measure: residents who can reach the stop (populated 450 m cells → stops), shown in the drawer only. CV R² 0.160 → **0.210** (default), 0.200 → **0.244** (best fit). Owner chose it as a score term with its own slider; the map shows the selected stop's **transit isochrone** (hexes by minutes, a layer toggle). |
| Overlap with neighbors (2026-10-21) | **Marginal value**, route-aware: per home/job/destination within the default walk, its decay weight at this stop minus at the quickest other stop **sharing a route** (`catch.marginal`, `55_catchments/20_overlap.sql`); shown as a stop color ("What it adds over neighbors", share of the catchment at current weights), a drawer section (also residents who'd walk 2+ min more) and a table column. Median stop adds ~9 %. **Split catchments** (each place shared among all stops reaching it by decay weight) were tested as the score's basis and predicted boardings worse in 20/20 splits (default CV 0.164 → 0.139, best fit 0.198 → 0.154): the score keeps full catchments. Origin/destination split declined (round trips). |
| Map behavior (2026-10-21) | Hex opacity doesn't change when a stop is selected. Opening/closing the drawer keeps the map's top-left corner fixed (a `resize` handler pans back MapLibre's keep-the-center resize) and pans only if the selected stop would be hidden. |
| Calibration (2026-10-20; revised 2026-10-21) | Fit the score's weights to **observed boardings per trip** (MPO, Feb 2024) at the fixed walk/decay; the fit **is the default** (the preset button went away with the walk/decay sliders). Special stops (schools, campus, park-and-rides, airport, transfer points) found from **OSM + stop names**, left out of the fit. Leftovers shown as a **"Riders vs. expected" stop color** (owner's picks among options). |
| Site data in git (2026-10-19) | `site/public/data/` is **gitignored** until the owner is happy with it. |
| Catchment file (2026-10-19) | All stops' blobs and spiderwebs in **one file**, `catchments.bin` (owner preference over one file per stop): a JSON index of byte ranges, then one raw-deflate record per stop (varint delta-encoded edge ids and coordinates, walk times as bytes in 10 s steps). The site fetches the index once and each selected stop's bytes with an HTTP range request, like PMTiles. 7.9 MB total (was 41 MB as JSON); ~9 kB per stop. Tried and rejected: storing the blob as non-overlapping rings (bigger: every boundary is stored twice). |

## Tech stack

| Layer | Choice |
|---|---|
| Pipeline language | Python 3.12, managed with **uv** |
| Lint/format | **ruff** |
| Tests | **pytest** (light; data checks against PostGIS) |
| Spatial database | **PostGIS 3.5 + pgRouting 4.0** (Docker; `db/Dockerfile` adds pgRouting to the multi-arch PostGIS image, since the official pgRouting images are amd64-only) |
| Transforms | **Plain numbered SQL files** run via `psql` |
| Orchestration | **Makefile** for step order; each step runs only when the SHA-256 of its inputs (files, config sections via `pipeline/deps.sh`, earlier steps' fingerprints) changes (`pipeline/stage.sh`), never by file timestamps (owner's call 2026-10-19); steps `exec` into one long-lived tools container |
| Geo CLI tools | GDAL/OGR (`ogr2ogr`), `osmium-tool`, **tippecanoe**, `pmtiles` CLI |
| Python libs | **pyosmium** (OSM with node ids), psycopg 3, **scipy** (clustering), **Shapely 2** (blob polygons), Typer, **r5py** (R5 transit routing; Java 21 in the container) |
| Reproducibility | **Docker Compose**: `db` + a `pipeline` tools container (pinned GDAL/tippecanoe/osmium/uv). DB on host port **5433** so it can run beside the sibling's. |
| Tile format | **PMTiles** (no tile server) |
| Frontend | **Vite + Solid + TypeScript** (Node 24; see `site/.nvmrc`) |
| Frontend lint/format | **ESLint** (typescript-eslint strict, eslint-plugin-solid) + **Prettier** |
| Map library | **MapLibre GL JS** + `pmtiles` protocol |
| Charts | **Observable Plot** (departures by hour) |
| Tables | **TanStack Table** (`@tanstack/solid-table`) |
| Basemap | **Protomaps** PMTiles extract of the study-area bbox |
| Hosting | **GitHub Pages**, deployed by GitHub Actions (`.github/workflows/deploy.yml`) |

## Data sources

URLs, layers, fields, licenses and recon findings live in `config/sources.toml`.
`transit download` fetches everything except the statewide parcels (manual; copy from
`../public-private-shore/data/raw/parcels/`).

| Source | Used for |
|---|---|
| **Madison Metro GTFS** | Stops, routes, trips, stop times, calendars. License: use limited to "assisting mass transit riders or promoting public transportation"; credit optional but, if given, must read exactly *"Data provided under license granted by City of Madison, WI, Metro Transit."* (we give it). |
| **OpenStreetMap** (Geofabrik Wisconsin) | Walk network (sidewalks are mapped almost everywhere; crossings well tagged), destinations, residential buildings |
| **2020 Census TIGER/Line blocks** (`TABBLOCK20`, carries `POP20`/`HOUSING20`) | Population and housing units per block |
| **LEHD LODES 8 WAC 2023** | Jobs per block |
| **City of Madison tax parcels** (ArcGIS service) | Dwelling units per parcel (`TotalDwellingUnits`) |
| **WI Statewide Parcel Map V12** | Parcels outside Madison (no unit count) |
| **Protomaps** daily build | Basemap |
| **2022 NHTS** (FHWA, public use v2.1) | Share of trips by destination purpose: sets destination group totals |
| **MPO Metro Ridership by Stop** (Feb 2024, City open data) | Calibrating the score; riders vs. expected per stop |

## Architecture

```
download -> load -> staging -> network -> stops -> generators -> catchments -> fit -> export -> site
 (files)  (ogr2ogr,  (SQL:      (SQL:      (Python    (SQL:        (pgRouting   (ridership (tiles,
          COPY,      typed,     corner     clustering dasymetric   per stop,    model)     stops.json,
          pyosmium)  3071)      model)     + SQL)     pop, POIs)   SQL sums)               catchments.bin,
                                                          \-> access (R5: transit       access.bin)
                                                               travel times) -> fit
```

Same file/database hybrid as public-private-shore: raw downloads are **files**, analysis
is **PostGIS SQL** (plus pgRouting and a little Python), and products are exported back
to **files**. Analysis CRS: **EPSG:3071** (Wisconsin Transverse Mercator, meters);
exports in EPSG:4326.

### Repo layout

```
.
├── AGENTS.md                 # this file (CLAUDE.md imports it)
├── README.md                 # human-facing overview + quickstart
├── docs/ARCHITECTURE.md      # how the code fits together
├── LICENSE, LICENSE-DOCS, LICENSE-DATA
├── Makefile                  # single entry point for the pipeline
├── docker-compose.yml        # db (PostGIS + pgRouting), pipeline (tools)
├── db/Dockerfile             # PostGIS image + pgRouting package
├── config/                   # ALL tunable pipeline knobs
│   ├── pipeline.toml         # study area, CRS, clustering, periods, walk model, blobs, tiles
│   ├── sources.toml          # URLs, licenses, retrieval dates, recon notes
│   ├── road_classes.csv      # OSM highway -> walkable? barrier? crossing waits
│   ├── poi_categories.csv    # OSM tag -> destination category + weight (first match wins)
│   ├── destination_groups.csv     # POI category -> trip-purpose group
│   ├── trip_purposes.csv     # NHTS WHYTO code -> trip-purpose group (blank = not a destination)
│   ├── special_stops.csv     # hand fixes to special stops (left out of the ridership fit)
│   └── stop_merge_overrides.csv   # hand fixes to stop merging (merge/split)
├── pipeline/
│   ├── Dockerfile, pyproject.toml, uv.lock
│   ├── src/transit/          # cli, config, download, load, osm, sqlrun, stops, reach, access,
│   │                         # purposes, fit, export
│   ├── sql/
│   │   ├── 00_init/          # extensions, schemas
│   │   ├── 10_staging/       # GTFS, census, parcels, OSM (typed, reprojected)
│   │   ├── 20_network/       # corner model, routing graph, connected components
│   │   ├── 30_stops/         # merged stops, frequencies, platform snapping
│   │   ├── 40_generators/    # population, jobs, POIs, snapping, density hexes
│   │   ├── 50_reach/         # per-edge walk times (after `transit reach`)
│   │   ├── 55_catchments/    # generator walk times, banded totals
│   │   ├── 60_export_network/      # network.pmtiles views
│   │   ├── 61_export_generators/   # generators.pmtiles views
│   │   └── 70_validation/    # ridership matched to stops, special stops (then `transit fit`)
│   └── tests/                # pytest data checks (run after the pipeline)
├── data/                     # raw/ and build/ (gitignored)
└── site/                     # Vite + Solid app; public/data/ is gitignored for now
```

## Methods

### Stops

- Platforms = GTFS stops with `location_type` 0 that appear in `stop_times`
  (1,659 of 1,681).
- Merging: complete-linkage hierarchical clustering on platform positions, 110 m max
  diameter; BRT platforms tied to their `parent_station`; overrides CSV. Result: 858
  merged stops, at most 6 platforms each. Owner's test cases (both merge, `tests/`):
  E Washington & North (183/185/2859/2860) and W Johnson & East Campus Mall
  (2843/2866, which also picks up the N Lake at W Johnson stops).
- Merged stop id = its lowest platform `stop_id` (stable across reruns unless
  membership changes). Name = the busiest platform's name (BRT: the station name).

### Frequency

- Representative date per day type = the first date with the most common set of active
  services (weekday 2026-09-01, Saturday 2026-08-22, Sunday 2026-08-16 for the current
  feed; overridable in `pipeline.toml`).
- Departures = stop_times with pickup allowed and a next stop. Counted per merged stop ×
  route × direction × day type × hour; period frequency = departures in the period's
  windows ÷ the windows' hours.
- Per direction (`transit.route_ways`, `period_freq_way`): a route's ways at a stop are
  its GTFS directions, merged into one when their mean headings are within 90° (51
  route-stop pairs, all loops). `period_freq` = the average over the ways a route runs in
  that period. Before (sum of directions, ×2 for one-way stops) → now: two-way stops
  about halve, one-way stops keep their scheduled count; the old bearing test had also
  flagged some corner stops (bus turns, opposite platforms) as one-way.
- The departures-by-hour chart still counts both directions.

### Walk network

- **Graph**: pyosmium splits every walkable highway way at shared nodes (that's what
  makes two ways connect; a bridge shares no node with the street under it) and at
  crossing/signal nodes. Edge cost = length ÷ 1.3 m/s.
- **Corner model** (`20_network/10_corners.sql`, `20_graph.sql`): at every node a barrier
  road passes through, its arms cut the surroundings into corners (sectors between
  consecutive arms, by azimuth). Sidewalks, side streets, driveways and crossing ways
  attach to the corner they enter. The barrier road itself is walkable along each side
  (two copies; snapping uses copies offset 6 m to each side so a stop or a house lands
  on its own side). Moving between corners = crossing an arm, through a **crossing
  connector** whose cost is the wait for its control (signal > marked > unmarked; from
  the crossing way's tags, the node's tags, or a traffic signal within 30 m) plus the
  crossing width ÷ speed. Divided roads (one-way carriageways) get half the wait per
  carriageway. Unmarked crossings of barrier roads get no connector (forbidden).
  Crossing ways that cut a barrier road without sharing a node are charged the same way.
- Only the main connected component is used for snapping.
- Result: 213k walk edges, 8.2k arterial edges (× 2 sides), 3.7k crossing connectors;
  4.6k arterial nodes have no crossing evidence and can't be crossed.

### Catchments

- `transit reach`: `pgr_drivingDistance` from all of a merged stop's platforms at once
  (equicost), out to 20 min, loading only edges within reach (~0.1 s per stop, 8 in
  parallel; ~7 s total).
- Generator walk time = time to the nearer reached end of its edge + along the edge +
  straight-line access distance ÷ speed. Totals per stop per 1-minute band
  (`catch.bands`), so the site can apply any limit and decay.
- Blob polygons (export.py, Shapely): reachable edge pieces per minute, buffered 25 m,
  closed by 40 m (grow then shrink, to fill blocks), holes under 2 ha filled (buildings
  ringed by reached paths have no indoor paths in OSM; owner 2026-10-21 after the
  airport terminal showed as a gap), simplified 5 m.

### Trip generators

- **Population**: each block's current estimate (`gen.block_pop`: `POP20`, plus in blocks
  whose units are all on Madison parcels, (units now − `HOUSING20`) × 2.08, not below 0;
  adding the change keeps dorm residents that no unit count includes) split over its
  parcels by dwelling units (parcel point = point on surface). Madison: `TotalDwellingUnits`. Elsewhere: a residential parcel =
  1 unit unless it holds OSM apartment/dormitory/terrace buildings (floor area ÷ 90 m²,
  3 levels if untagged); condo stacks (identical polygons) count once. Sanity: 85.5k
  estimated units outside Madison vs ~80k in the census. Blocks with people but no unit
  parcels keep them at a point inside the block (379 blocks).
- **Jobs**: LODES block totals at a point inside the block.
- **Destinations**: OSM POIs → categories by the first matching rule; same-named pieces
  of one place within 300 m merge; parks/gardens inside a bigger park/garden are dropped
  as part of it (2026-10-19: the UW Arboretum had ~40 tree-collection points inside
  Longenecker Gardens, each counted as a botanical garden); parks/gardens scale by √(area in ha), clamped to
  `park_scale_min`–`park_scale_max` (owner set 0.5–2 on 2026-10-19, and botanical
  gardens to weight 3 instead of 10, after the Arboretum looked overweighted); polygons reachable from outline points every 75 m. Private ones dropped
  (`access=private/no`, `garden:type=residential/private`).
- **Destination totals by trip purpose** (2026-10-21; `transit purposes`, end of
  `30_pois.sql`): weighted NHTS shares of urban trips to each purpose group (shopping 27 %,
  meals 21 %, errands/civic/religious 16 %, school 12 %, exercise 10 %, recreation 8 %,
  health 5 %, lodging 2 %) scale each group of categories so its total weight is that
  share of the overall total (unchanged). Within a group the hand weights still decide:
  recreation's 8 % goes mostly to parks, so bars, theatres and museums end up small.
  Transit-only NHTS trips (100 to a destination nationally) were too few; they fit
  ridership worse.
- **Airport terminal** (2026-10-21): `aeroway=terminal`, weight 20, in the lodging
  (travel) group: the survey has no airport purpose. The airport's LODES jobs sit at
  block points 1.4–1.7 km away on the airfield side (big-block lumping), so the
  terminal stop shows 0 jobs.
- **Jobs over buildings: tried and reverted (2026-10-21)**. Spreading each block's jobs
  (and shop jobs) over its non-residential OSM buildings by floor area (not on
  residential parcels, ≥ 50 m²; 1,780 of 3,389 job blocks, 11,700 buildings) placed jobs
  more realistically (airport terminal stop 0 → 225 jobs within 10 min) but didn't help
  the ridership fit: default CV R² 0.152 → 0.150, best fit 0.188 → 0.178. Owner chose
  to revert. Building value was ruled out first: Madison's exempt parcels (UW,
  hospitals, government, the airport) have no assessed improvement value. Blocks over
  25 ha hold 27 % of jobs.
- **Shop and clinic jobs** (`gen.points` kind `shopjobs`): retail + health-care jobs per
  block, part of other destinations at `shop_jobs_weight` points per job (fit: 0.022).
- **Density map layer**: 150 m hexagons of homes (residents), jobs and other destinations
  per km². A destination area (park, garden, campus) spreads its weight over the hexes
  it covers, by area; points count where they fall. Destinations are stored per category
  (`d_<category>`) plus `shop_jobs_km2`; the site sums them with the fitted points per
  shop job.

## Frontend

- **Generator hexes (decided 2026-10-19)**: checkboxes for population (blue), jobs (green)
  and destinations (yellow; destination points per km²). With two checked each hex
  splits into halves, with three into three wedges (center to alternating edge
  midpoints; rhombi were rejected for their 3D-cube illusion), one generator per piece,
  in that order
  (`gen.hex_parts`, `export.hex_parts`).
- **Basemap**: Protomaps style with its greens (parks, woods, scrub, green landcover)
  replaced by the land color (`neutralFlavor` in `map/colors.ts`), so green only means
  jobs. A style override; the tiles are unchanged.
- **Map tab** (`site/src/map/MapView.tsx`): generator hexes (above), route lines (GTFS shapes in
  Metro's route colors), stops as circles sized by √frequency and colored by score or
  frequency (orange ramp), the selected stop's blob + spiderweb (violet; spiderweb colored per edge with
  MapLibre feature-state), a hover preview of another stop (fainter blob, dashed outline
  at the walk limit, gray spiderweb on feature-state key `h`), optional destinations and
  arterial-crossing layers.
- **Layout (decided 2026-10-19)**: the left panel never changes (intro, settings,
  layers); a selected stop opens in a **right-hand drawer** (bottom sheet on phones,
  replacing the panel until closed).
- **Stop analysis tab** (`site/src/stops/`): sortable, filterable TanStack table, settings
  sidebar, detail panel with "Show walkshed on map".
- **What it adds over neighbors**: a "Stops colored by" option (score ramp, breaks 5/10/
  20/40 %), a drawer section and an "Adds" table column; computed in `scoring.ts` from
  `stops.json` `overlap` (full/added totals by group at the default walk) with the
  current weights.
- **Riders vs. expected**: a "Stops colored by" option (diverging red ↔ gray ↔ blue,
  hollow = no data), a drawer section with observed/expected and special-stop reasons,
  a table column.
- **Settings**: Walk (Default assumption / Best fit buttons, walk limit 5–20, half-life
  1–20), three weight sliders (Homes, Jobs, Other destinations), the service period.
  Presets come from `stops.json` `settings.score` (`preset()`, `applyPreset()`,
  `activePreset()` in `state/store.ts`); period weights are read-only. Riders vs.
  expected always uses the default assumption's fit.
- **About tab**: methodology and sources.
- Settings live in the URL (`state/url.ts`); `?stop=` accepts a merged-stop id or any
  platform's GTFS stop id.
- Colors (`map/colors.ts`, checked with the dataviz validator, light and dark): orange
  for scores; blue, green, yellow for the three generators; violet for catchments;
  red ↔ blue diverging for riders vs. expected (magenta ↔ aqua was tried to avoid blue
  but fails CVD: deuteranopes can't tell the arms apart).

### Calibration against ridership (2026-10-20)

The `fit` step (`70_validation/`, `fit.py`; runs in `make`, ~5 s, before `stops.json`):

- **Data**: the MPO's weekday boardings per stop (February 2024, farebox + AVL
  estimates; before the BRT opened on 2024-09-22), matched to platforms by stop code
  within 50 m, else the nearest platform within 30 m (96 % of boardings match; the big
  miss is South Transfer Point, closed), summed per merged stop.
- **Special stops** (`valid.special`, left out of the fit): within 150 m of a named
  middle/high school or named for one ("... at Memorial High": its OSM outline has no
  name), inside a university/college polygon, park-and-rides (OSM `park_ride` lots or
  the name), the airport (name), transfer points (5+ routes). 101 stops. Fixes in
  `config/special_stops.csv` (`reason` = none clears a stop).
- **Model**: the score's own formula fit to boardings per trip/h (weekday frequency) at
  the fixed walk/decay (`[score]`): `b0 + w_pop·pop + w_jobs·jobs + w_osm·osm +
  w_shop·shop_jobs`, non-negative, least squares on log(1 + ·) (raw-scale least squares
  put all weight on destinations, driven by a few big stops); 600 stops fit (not
  special, ≥ 0.5 trips/h). osm and shop jobs fold into one slider: other destinations =
  osm + (w_shop / w_osm) · shop_jobs.
- **Result (2026-10-21)**: homes 5, jobs 0.5, other destinations 4 (0–5 sliders), 0.022
  points per shop job; R² 0.168 (5-fold CV 0.152). By half-life at 10 min: 0.186 (1
  min), 0.184 (2), 0.168 (4), 0.157 (8). History: the first fit (2026-10-20, walk and
  half-life free, hand destination weights) chose a 6 min walk and 3 min half-life,
  R² 0.177. Jobs get little weight once shop jobs are in. Rank correlation with
  boardings: frequency 0.77; the catchment explains a modest share of riders per trip.
- **Site**: default weights = the fit; stop color "Riders vs. expected" = (observed + 5)
  ÷ (expected + 5), expected = the fit × weekday frequency (fixed, not the sliders);
  drawer section and table column. Report with correlations and the
  biggest residuals: `data/build/validation/ridership.md`.
- **BRT stations over-perform (owner reviewed 2026-10-21, left as is)**: the 19 stations
  have a median riders-vs-expected of ×4.3 (other Route A stops ×1.5, the rest ×1.02).
  Not a walk-model bug (Route A walksheds are larger than average); a longer station
  walkshed only gets to ×2.3. Likely: the 2024 boardings are the old Route A's busiest
  stops, where the stations were then sited (selection), plus a rapid-line premium.
  A station term in the model would fit ×5 and raise R² 0.18 → 0.25; the owner chose
  to wait for post-BRT (2025 APC) data instead.
- **Caveats**: 2024 riders vs. 2026 service; frequency is partly circular; boardings
  per trip also depend on where the route goes and position on the line; residuals are
  where the placement question starts, not answers.

## Testing

`make test` (after `make`): pytest data checks in `pipeline/tests/`: every
platform in exactly one merged stop; the owner's two merge examples; BRT stations stay
whole; platforms snap within 50 m; dasymetric population sums to the census; estimated
units outside Madison near the census; Route A peak frequency plausible per direction (one-way and two-way stop); a 10-minute
walkshed area plausible; no arterial crossing without signal/marking evidence; > 90 % of
boardings matched; fitted settings inside the slider ranges; destination group totals
match the trip shares; a stop's added value within its full catchment.
`npm run check` in `site/` runs Prettier, ESLint and tsc. No frontend test suite.

Refactors of the pipeline are checked with checksums: the output is deterministic, so
record `shasum -a 256 site/public/data/*` before, rerun, and compare (see
docs/ARCHITECTURE.md, "Verifying a change"). To look at the site, see "Screenshots" there.

## Working notes (for the next session)

Things learned the hard way; check these before debugging the same problem again.

- **Node 24** (`site/.nvmrc`). The shell's default `node` may be 20: run
  `export PATH=~/.nvm/versions/node/v24.22.0/bin:$PATH` first. Installing packages under
  Node 20 left Vite without its native bundler binding (rolldown), and ESLint 10 crashes
  on Node 20.
- **The pipeline container**: `make` starts it (`tools-up`); run one-off commands with
  `docker compose exec -T pipeline uv run --project pipeline transit <cmd>` (or `python`,
  `pytest`). The DB is on host port 5433.
- **Rerun logic**: `pipeline/stage.sh` and `pipeline/deps.sh` are not inputs to any step.
  After editing them, delete `data/build/.stamps/` (or `make db-reset`) to rebuild.
  Running one stage by hand (e.g. `transit sql 30_stops`) doesn't update its stamp, and
  rerunning 30_stops alone gives platform vertices new ids, leaving later stages stale:
  prefer `make <target>`.
- **psql variables don't expand inside function bodies** (`$$ ... $$`): pass them as
  arguments (`20_graph.sql`) or generate SQL with `\gexec` (`50_hex.sql`).
- **MapLibre**: the Protomaps basemap already has a layer called `pois` (ours is
  `destinations`); a `["zoom"]` expression must be the outermost `interpolate`/`step`;
  `--use-attribute-for-id` in tippecanoe needs numeric ids (text ids go in another
  column, e.g. `osm_id`).
- **Solid**: no `<>` fragments inside an element; eslint-plugin-solid flags signal reads
  in MapLibre callbacks (wrap intentional ones in `untrack`).
- **Shell**: zsh doesn't word-split `$VAR`; use arrays (`F=(a b); cmd $F`). `which time`
  is a keyword in zsh; use `/usr/bin/time -p`.
- **Owner's working style**: workshop design choices with options and a recommendation
  (mockups help); say plainly when an earlier claim was wrong; verify refactors produce
  identical output; commit on `main`, never push.

## Milestones

1. ✅ **Data recon.** Findings in `config/sources.toml`.
2. ✅ **Thin slice: one stop** (E Washington & North).
3. ✅ **All stops + frequency.**
4. ✅ **Trip generators.**
5. ✅ **Scoring + Map tab.**
6. ✅ **Stop analysis tab.**
7. **Ship.** Owner review; commit `site/public/data/` (un-ignore it); first deploy;
   check the size budget (see Open questions).
8. **Explain and polish.** Review the About page, performance on phones, more owner
   test cases.

## Open questions

- **A critique of the analysis's assumptions** is in `docs/assumptions-critique.md`
  (owner's local notes, deliberately not committed; may be missing in a fresh clone).
  Its top suggestions: validate the score against stop-level boardings and fit the
  weights (done 2026-10-20, see [Calibration](#calibration-against-ridership-2026-10-20); the MPO
  also has an April 2025 APC-based estimate, post-BRT, only as a PDF map: worth asking for); use current dwelling units for population (done 2026-10-21); add ACS zero-car households
  (declined by the owner, see Decisions);
  per-direction frequency instead of the ×2 rule (done 2026-10-20); separate
  origin/destination scores (declined: round trips) and a stop-overlap view (done
  2026-10-21, see Decisions).
- **Faster blobs (offered, not done)**: build each band from the previous band plus the
  new pieces (incremental union) instead of a full union per band; the unions are ~70 %
  of the blob export (~60 s). Output would differ by up to ~1 m in places, so verify by
  decoding both `catchments.bin` files and comparing blob areas, not checksums.
- **CPU settings (offered, not done)**: move the blob worker count (`export.catchments`,
  default = CPUs Docker allots) and `reach.py` `WORKERS = 8` into a `pipeline.toml`
  section.
- **Stop colors vs. the yellow destinations ramp**: close hues; if confusing, move stop
  scores to another hue.
- Weekday peak windows and period weights are first guesses; check them against Metro's
  actual service span.
- Tertiary roads are not barriers. Some (e.g. busy collectors) might deserve it;
  `road_classes.csv` can flip them.
- Destination weights are first guesses.
