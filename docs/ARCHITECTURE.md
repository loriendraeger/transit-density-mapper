# Architecture

How the code fits together, and where to change things. For goals, decisions and
methods, see [AGENTS.md](../AGENTS.md).

## Pipeline

Every step runs inside the `pipeline` container (`docker compose run --rm pipeline uv run
--project pipeline transit <command>`); the Makefile wraps them with stamp files in
`data/build/.stamps/`, so editing a stage's SQL (or anything in `config/`) reruns that
stage and everything after it.

| Make target | What runs | Reads | Writes |
|---|---|---|---|
| `download` | `transit download` (download.py) | `config/sources.toml` | `data/raw/` |
| `init` | `sql/00_init` | | extensions, schemas |
| `load` | `transit load` (load.py, osm.py) | `data/raw/` | `raw.*` |
| `staging` | `sql/10_staging` | `raw.*`, `config/*.csv` | `staging.*` (typed, EPSG:3071) |
| `network` | `sql/20_network` | `staging.osm_*`, `road_classes.csv` | `net.base_edges`, `net.vertices` |
| `stops` | `transit cluster` (stops.py) + `sql/30_stops` | `staging.stops`, GTFS | `transit.*`, `net.edges` (split at platforms) |
| `generators` | `sql/40_generators` | parcels, blocks, jobs, POIs | `gen.*` |
| `catchments` | `transit reach` (reach.py) + `sql/50_catchments` | `net.edges`, `gen.snap` | `catch.*` |
| `export` | `sql/60_export` + `transit export` (export.py) | everything | `site/public/data/` |
| `basemap` | `transit basemap` | Protomaps build (HTTP) | `site/public/data/basemap.pmtiles` |
| `test` | pytest `pipeline/tests/` | the database | |

### Schemas

- `raw`: as delivered. GTFS tables are all text; OSM comes from pyosmium as
  `osm_edges` (ways split at graph nodes, with node ids), `osm_nodes`, `osm_pois`,
  `osm_buildings`.
- `staging`: typed and reprojected; `service_days` expands the GTFS calendar.
- `net`: the routing graph. `ends`/`arms`/`end_sector` build the corner model;
  `vertices` (one per ordinary node, one per corner of an arterial node, plus platform
  split points); `base_edges` (kinds `walk`, `side_l`, `side_r`, `cross`); `edges` =
  `base_edges` split at platforms (rebuilt by 30_stops, so that stage is rerunnable).
- `transit`: `platform_cluster`, `clusters`, `rep_dates`, `departures`,
  `directionality`, `hourly`, `period_freq`.
- `gen`: `parcel_units`, `population`, `jobs`, `pois`, `poi_points`, `points` (all
  generators), `snap` (point -> edge), `hex`.
- `catch`: `reach` (stop × vertex × seconds), `edge_time`, `gen_time`, `bands`.
- `export`: views that become tile layers (`walk`, `crossings`, `hex`, `pois`,
  `platforms`).

### Where to change things

| To change | Edit |
|---|---|
| Which roads are barriers, crossing waits | `config/road_classes.csv` |
| Walk speed, signal search distance, snapping | `config/pipeline.toml [walk]` |
| Stop merging distance | `[stops] cluster_max_diameter_m`; one-off fixes in `config/stop_merge_overrides.csv` (`stop_id,action,group,note`; action `merge` with a shared group label, or `split`) |
| Service periods, one-way test | `[frequency]` |
| Destination categories and weights | `config/poi_categories.csv` (first matching row wins; category `ignore` drops) |
| Unit estimates outside Madison | `[generators]` and `40_generators/10_population.sql` |
| Blob shape | `[catchments]` |
| Which layers go into which PMTiles | `[tiles.files.*]` |

## Site outputs (`site/public/data/`)

| File | Contents | Made by |
|---|---|---|
| `stops.json` | Every merged stop: name, codes, routes, one-way flag, trips/hour by period × route, departures by hour × day type, banded totals per measure; plus routes, measures, settings, sources | `export.stops_json` |
| `catchments.json` | Per stop: spiderweb (walk-network edge ids, delta-encoded, + seconds) and blob (20 cumulative polygons, delta-encoded 1e-5° integers) | `export.catchments` |
| `network.pmtiles` | `walk` (edges, feature id = `staging.osm_edges.id`), `crossings` | tippecanoe |
| `generators.pmtiles` | `hex`, `pois`, `platforms` | tippecanoe |
| `basemap.pmtiles` | Protomaps extract | `pmtiles extract` |

Types for the JSON files: `site/src/lib/contract.ts`. Keep it in step with export.py.

## Site (`site/src/`)

| Path | Role |
|---|---|
| `index.tsx`, `App.tsx` | Hash router (`#/map`, `#/stops`, `#/about`), shell with tabs. The map stays mounted while hidden. |
| `state/store.ts` | Signals: data, settings, selection, layer options; `scored` memo (every stop scored at the current settings) |
| `state/url.ts` | Settings <-> URL search params, both ways |
| `lib/scoring.ts` | Decay curves, band weights, component sums, normalization, frequencies |
| `lib/catchment.ts` | Loads `catchments.json` once, decodes a stop; solves blob band opacities so the blob fades like the decay |
| `map/MapView.tsx` | MapLibre map: sources, layers, effects that push state into the map |
| `map/colors.ts` | Validated ramps and class breaks |
| `components/` | Side panel, settings, stop detail, hourly chart (Observable Plot) |
| `stops/` | Stop analysis view and TanStack table |
| `about/About.tsx` | Methodology page |
