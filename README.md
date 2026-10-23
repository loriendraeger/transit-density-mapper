# Madison Metro Stop Catchments

This was vibe coded over a few days. Quality and utility are dubious.

## Quickstart

Needs Docker and Node 24.

```sh
cp .env.example .env
make download        # every source in config/sources.toml
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
