# Madison Metro stop catchments

Who lives and works within a short walk of each Madison Metro bus stop, what there is
to walk to, and how often the bus comes. A static site (map + stop table) built from
public data by a local PostGIS/pgRouting pipeline.

- **Map:** population or job density, stops colored by potential and sized by
  frequency; click a stop for its walkshed (a spiderweb of walkable paths and a blob that
  fades with walking time). Walks can only cross arterials at signals or marked
  crosswalks, and pay the expected wait.
- **Stop analysis:** every stop (merged where platforms share a corner), with scores,
  trips per hour by period and route, and departures by hour.
- **Two scores:** *potential* (the default), trip ends a day by every mode within a
  short walk, from national travel-survey rates, irrespective of how people travel
  today; and a score *tuned to today's riders*, with weights fit to stop boardings.
- Walk-time limit, half-life, service period and (for the tuned score) weights are
  adjustable.

## Quickstart

Needs Docker and Node 24.

```sh
cp .env.example .env
make download        # everything but the statewide parcels (see config/sources.toml)
make all             # load -> network -> stops -> generators -> catchments -> export
make basemap         # Protomaps extract for the map background
make test            # data checks
cd site && npm ci && npm run dev
```

See [AGENTS.md](AGENTS.md) for goals, decisions and methods, and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the code fits together.

## Data

Data provided under license granted by City of Madison, WI, Metro Transit.
© OpenStreetMap contributors (ODbL). U.S. Census Bureau (2020 Census, LEHD LODES).
City of Madison Assessor. Wisconsin Statewide Parcel Map Initiative. Protomaps.

## License

Code: GPL-3.0-or-later ([LICENSE](LICENSE)). Docs: CC BY-SA 4.0
([LICENSE-DOCS](LICENSE-DOCS)). Data outputs: ODbL 1.0 ([LICENSE-DATA](LICENSE-DATA)).
