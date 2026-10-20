# AGENTS.md

Guidance for AI coding agents (and humans) working in this repo.

## Project

**Goal: show how well each Madison Metro stop is placed relative to the things that
generate transit trips** (people, jobs, and destinations) and how often buses actually
serve it.

Two views on one static site:

1. **Map.** Trip generators (population or job density, destinations), transit stops,
   and the selected stop's **walk catchment**: a spiderweb of walkable paths and a blob
   that fades as walking time grows.
2. **Stop analysis tab.** One row per (merged) stop: frequency through the day for each
   service period, and a **catchment score** for the trip generators within walking
   distance. Each stop has a detail view.

Users can tinker: the **walk-time limit** (5–20 min slider), the **weights** that make up
the score, the **decay curve**, the **service period**, and how map layers look.
Everything adjustable is computed in the browser from precomputed data.

Two halves, as in `../public-private-shore`:

1. **Data pipeline** (local, run by hand): raw public datasets go in, and map tiles plus
   per-stop data come out.
2. **Static site** (GitHub Pages, client-only): renders the pipeline's outputs.

**Status (2026-10-19):** milestones 1–6 done in a first pass, built in one autonomous
session and **not yet reviewed by the owner**. The full pipeline runs from `make`
(under 3 minutes from scratch, after downloads), and the site runs locally
(`make site`). `site/public/data/` is **gitignored until the owner is happy with it**,
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
| One-way stops (2026-10-19) | Stops whose departures all head one way (one side of a couplet like Gorham/Johnson, line termini, one-side stops whose opposite stop is > 110 m away) count their frequency **× `one_way_factor` (2, set in `pipeline.toml`; owner 2026-10-19: users can't change it)**. Test: every departure's bearing to its next stop within 100°. |
| Crossing penalty (2026-10-19, confirmed after review) | **Barrier-style**, implemented as the **corner model** (see [Walk network](#walk-network)): trunk/primary/secondary roads can only be crossed at signals or marked crossings, costing the expected wait plus the walk across. **Unmarked crossings of them stay forbidden** (owner kept this over Wisconsin's every-intersection-is-a-crosswalk rule). Waits per class in `config/road_classes.csv`. |
| Population (2026-10-19) | **2020 Census blocks, split among parcels by dwelling units** (dasymetric). Madison parcels have `TotalDwellingUnits`; elsewhere units are estimated. Not capturing growth since 2020 is an accepted limitation. |
| Jobs (2026-10-19) | **LEHD LODES 8 WAC, 2023**, at a point inside each block (lumping big suburban blocks is accepted). |
| Destinations (2026-10-19) | **OSM POIs** with per-kind weights (`config/poi_categories.csv`); the site multiplies whole categories. |
| Score (2026-10-19) | Each component (population, jobs, destinations) is summed with the **decay weight** of its walk time, **normalized 0–100 against the best stop at the same settings**, then weight-averaged. Decays: none, linear, exponential (half-life), S-curve (midpoint). Default: exponential, 8 min half-life, 10 min limit. |
| Blob rendering (2026-10-19) | Cumulative 1-minute bands stacked with per-band opacities solved so the **blob's opacity at time t follows the score's decay curve**. |
| Licenses (2026-10-19) | **Same split as the sibling**: code GPL-3.0-or-later (`LICENSE`), docs CC BY-SA 4.0 (`LICENSE-DOCS`), outputs ODbL 1.0 with upstream attributions (`LICENSE-DATA`; required by OSM). |
| Site data in git (2026-10-19) | `site/public/data/` is **gitignored** until the owner is happy with it. |
| Catchment file (2026-10-19) | All stops' blobs and spiderwebs in **one `catchments.json`** (owner preference over one file per stop), loaded on the first stop selection. Size is an open question. |

## Tech stack

| Layer | Choice |
|---|---|
| Pipeline language | Python 3.12, managed with **uv** |
| Lint/format | **ruff** |
| Tests | **pytest** (light; data checks against PostGIS) |
| Spatial database | **PostGIS 3.5 + pgRouting 4.0** (Docker; `db/Dockerfile` adds pgRouting to the multi-arch PostGIS image, since the official pgRouting images are amd64-only) |
| Transforms | **Plain numbered SQL files** run via `psql` |
| Orchestration | **Makefile** with stamp files |
| Geo CLI tools | GDAL/OGR (`ogr2ogr`), `osmium-tool`, **tippecanoe**, `pmtiles` CLI |
| Python libs | **pyosmium** (OSM with node ids), psycopg 3, **scipy** (clustering), **Shapely 2** (blob polygons), Typer |
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

## Architecture

```
download -> load -> staging -> network -> stops -> generators -> catchments -> export -> site
 (files)  (ogr2ogr,  (SQL:      (SQL:      (Python    (SQL:        (pgRouting   (tiles,
          COPY,      typed,     corner     clustering dasymetric   per stop,    stops.json,
          pyosmium)  3071)      model)     + SQL)     pop, POIs)   SQL sums)    catchments.json)
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
│   └── stop_merge_overrides.csv   # hand fixes to stop merging (merge/split)
├── pipeline/
│   ├── Dockerfile, pyproject.toml, uv.lock
│   ├── src/transit/          # cli, config, download, load, osm, sqlrun, stops, reach, export
│   ├── sql/
│   │   ├── 00_init/          # extensions, schemas
│   │   ├── 10_staging/       # GTFS, census, parcels, OSM (typed, reprojected)
│   │   ├── 20_network/       # corner model, routing graph, connected components
│   │   ├── 30_stops/         # merged stops, frequencies, platform snapping
│   │   ├── 40_generators/    # population, jobs, POIs, snapping, density hexes
│   │   ├── 50_catchments/    # edge/generator walk times, banded totals
│   │   └── 60_export/        # tile-layer views
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
  route × day type × hour; period frequency = departures in the period's windows ÷ the
  windows' hours.
- One-way factor: fixed in `pipeline.toml`, shipped in `stops.json` settings, applied in the browser.

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
  closed by 40 m (grow then shrink, to fill blocks), simplified 5 m.

### Trip generators

- **Population**: block `POP20` split over its parcels by dwelling units (parcel point
  = point on surface). Madison: `TotalDwellingUnits`. Elsewhere: a residential parcel =
  1 unit unless it holds OSM apartment/dormitory/terrace buildings (floor area ÷ 90 m²,
  3 levels if untagged); condo stacks (identical polygons) count once. Sanity: 85.5k
  estimated units outside Madison vs ~80k in the census. Blocks with people but no unit
  parcels keep them at a point inside the block (379 blocks).
- **Jobs**: LODES block totals at a point inside the block.
- **Destinations**: OSM POIs → categories by the first matching rule; same-named pieces
  of one place within 300 m merge; parks/gardens scale by √(area in ha), clamped
  0.5–4; polygons reachable from outline points every 75 m. Private ones dropped
  (`access=private/no`, `garden:type=residential/private`).
- **Density map layer**: 150 m hexagons of population and jobs per km².

## Frontend

- **Map tab** (`site/src/map/MapView.tsx`): density hexes (blue), stops as circles sized by
  √frequency and colored by score or frequency (orange ramp), selected stop's blob +
  spiderweb (violet; spiderweb colored per edge with MapLibre feature-state), optional
  destinations and arterial-crossing layers. Side panel: stop detail, settings, layers.
- **Stop analysis tab** (`site/src/stops/`): sortable, filterable TanStack table, settings
  sidebar, detail panel with "Show walkshed on map".
- **About tab**: methodology and sources.
- Settings live in the URL (`state/url.ts`); `?stop=` accepts a merged-stop id or any
  platform's GTFS stop id.
- Colors: three validated ramps that don't compete (dataviz validator, light and dark):
  orange for scores, blue for density, violet for catchments. See `map/colors.ts`.

## Testing

`make test` (after `make catchments`): pytest data checks in `pipeline/tests/`: every
platform in exactly one merged stop; the owner's two merge examples; BRT stations stay
whole; platforms snap within 50 m; dasymetric population sums to the census; estimated
units outside Madison near the census; Route A peak frequency plausible; a 10-minute
walkshed area plausible; no arterial crossing without signal/marking evidence.
`npm run check` in `site/` runs Prettier, ESLint and tsc. No frontend test suite.

To screenshot the site headlessly, plain headless Chrome has no WebGL2 on this Mac; use
Playwright with the system Chrome and `--use-gl=angle --use-angle=metal`.

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

- **Catchment data size**: `catchments.json` is 41 MB (12 MB gzipped), loaded on the
  first stop selection. One file was the owner's preference; the owner will ask about
  why it's so big. Most of it is the blob polygons (20 cumulative bands per stop) and the
  spiderweb edge lists. Levers: coarser bands for the blob, coarser coordinates,
  per-stop files, or computing blobs in the browser from the spiderweb.
- Weekday peak windows and period weights are first guesses; check them against Metro's
  actual service span.
- Tertiary roads are not barriers. Some (e.g. busy collectors) might deserve it;
  `road_classes.csv` can flip them.
- Destination weights are first guesses.
