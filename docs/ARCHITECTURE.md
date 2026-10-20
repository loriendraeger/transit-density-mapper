# Architecture

How the code fits together, and where to change things. For goals, decisions and
methods, see [AGENTS.md](../AGENTS.md).

## Pipeline

Every step runs in one long-lived `pipeline` container (`make tools-up` starts it; the
Makefile runs `docker compose exec -T pipeline uv run --project pipeline transit
<command>`). Stamp files in `data/build/.stamps/` track the database stages. Each stamp
depends on its stage's SQL and Python, the stamps before it, and only the config it
reads: whole config files, or content stamps from `pipeline/deps.sh` in
`data/build/deps/` (one per `pipeline.toml` section, plus the two config columns the
loader reads), which are rewritten only when their content changes. A no-op `make` takes
about a second; changing a destination weight reruns only generators -> catchments ->
`stops.json` and `generators.pmtiles` (~20 s); a full rebuild including the load is
under 3 minutes.

| Make target | What runs | Reads (config) | Writes |
|---|---|---|---|
| `download` | `transit download` (download.py) | `sources.toml` | `data/raw/` |
| `init` | `sql/00_init` | | extensions, schemas |
| `load` | `transit load` (load.py, osm.py) | `sources.toml`, POI keys, walkable road classes, `[study_area]` | `raw.*` |
| `staging` | `sql/10_staging` | `road_classes.csv`, `[analysis]` | `staging.*` (typed, EPSG:3071) |
| `network` | `sql/20_network` | `[walk]` | `net.base_edges`, `net.vertices` |
| `stops` | `transit cluster` (stops.py) + `sql/30_stops` | `stop_merge_overrides.csv`, `[stops]`, `[frequency]`, `[walk]` | `transit.*`, `net.edges` (split at platforms) |
| `generators` | `sql/40_generators` | `poi_categories.csv`, `[generators]`, `[walk]`, `[study_area]` | `gen.*` |
| `reach` | `transit reach` (reach.py) + `sql/50_reach` | `[walk]` | `catch.reach`, `catch.edge_time` |
| `catchments` | `sql/55_catchments` | `[walk]` | `catch.gen_time`, `catch.bands` |
| `export` | `sql/60_export_network`, `sql/61_export_generators`, then `transit tiles network`, `transit tiles generators`, `transit stops-json`, `transit catchments` (export.py) | `[tiles]`, `[frequency]`, `[catchments]`... | `site/public/data/` |
| `basemap` | `transit basemap` | Protomaps build (HTTP) | `site/public/data/basemap.pmtiles` |
| `test` | pytest `pipeline/tests/` | | |

The output is deterministic (sums in `numeric`, ordered inputs and views): two runs give
byte-identical files, so a refactor can be checked with checksums.

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
- `catch`: `reach` (stop × vertex × seconds), `edge_time` (reach stage); `gen_time`, `bands` (catchments stage).
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
| `catchments.bin` | Per stop: spiderweb (walk-network edge ids + walk times) and blob (20 cumulative polygons), in one binary file with a JSON index of byte ranges; layout documented at `CATCH_FILE` in export.py | `export.catchments` |
| `network.pmtiles` | `walk` (edges, feature id = `staging.osm_edges.id`), `crossings` | tippecanoe |
| `generators.pmtiles` | `hex`, `pois`, `platforms`, `routes` (GTFS shapes run on the representative days) | tippecanoe |
| `basemap.pmtiles` | Protomaps extract | `pmtiles extract` |

Types for the JSON files: `site/src/lib/contract.ts`. Keep it in step with export.py.

## Site (`site/src/`)

| Path | Role |
|---|---|
| `index.tsx`, `App.tsx` | Hash router (`#/map`, `#/stops`, `#/about`), shell with tabs. The map stays mounted while hidden. |
| `state/store.ts` | Signals: data, settings, selection, layer options; `scored` memo (every stop scored at the current settings) |
| `state/url.ts` | Settings <-> URL search params, both ways |
| `lib/scoring.ts` | Decay curves, band weights, component sums, normalization, frequencies |
| `lib/catchment.ts` | Fetches `catchments.bin`'s index, then one stop's record by HTTP range request (falls back to the whole file if the server ignores Range); inflates and decodes it; solves blob band opacities so the blob fades like the decay |
| `map/MapView.tsx` | MapLibre map: sources, layers, effects that push state into the map |
| `map/colors.ts` | Validated ramps and class breaks |
| `components/` | Left panel (settings, layers) and the right-hand stop drawer (`Panel.tsx`), settings, stop detail, hourly chart (Observable Plot) |
| `stops/` | Stop analysis view and TanStack table |
| `about/About.tsx` | Methodology page |
