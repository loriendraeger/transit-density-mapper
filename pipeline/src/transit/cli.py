"""`transit <command>`: the pipeline entry point, called by the Makefile."""

from typing import Annotated

import typer

from . import download as download_mod
from . import export as export_mod
from . import fit as fit_mod
from . import load as load_mod
from . import reach as reach_mod
from . import sqlrun
from . import stops as stops_mod

app = typer.Typer(no_args_is_help=True, add_completion=False)

Sources = Annotated[list[str] | None, typer.Argument(help="sources.toml sections (default: all)")]


@app.command()
def download(sources: Sources = None, force: bool = False):
    """Fetch raw downloads into data/raw/ (skips files that exist)."""
    download_mod.download(sources, force)


@app.command()
def load(sources: Sources = None):
    """Load raw downloads into the PostGIS `raw` schema."""
    load_mod.load(sources)


@app.command()
def sql(
    stage: Annotated[str, typer.Argument(help="pipeline/sql directory, e.g. 10_staging")],
    set_: Annotated[
        list[str] | None,
        typer.Option("--set", help="override a pipeline.toml value: key=value (repeatable)"),
    ] = None,
):
    """Run one SQL stage."""
    if stage not in sqlrun.stages():
        raise typer.BadParameter(f"unknown stage; choose from {sqlrun.stages()}")
    overrides = dict(kv.split("=", 1) for kv in set_ or [])
    sqlrun.run_stage(stage, overrides)


@app.command()
def cluster():
    """Merge nearby stops into clusters (transit.platform_cluster)."""
    stops_mod.cluster()


@app.command()
def reach():
    """Walk times from every merged stop (catch.reach), with pgRouting."""
    reach_mod.reach()


@app.command()
def export():
    """Write all of site/public/data/ (except the basemap): tiles, stops.json,
    catchments.bin. The Makefile builds them one by one instead, each only when its
    inputs change."""
    export_mod.tiles()
    export_mod.stops_json()
    export_mod.catchments()


@app.command()
def tiles(
    names: Annotated[
        list[str] | None, typer.Argument(help="[tiles.files] entries (default: all)")
    ] = None,
):
    """Build site/public/data/<name>.pmtiles from the export views."""
    export_mod.tiles(names)


@app.command("stops-json")
def stops_json():
    """Write site/public/data/stops.json."""
    export_mod.stops_json()


@app.command()
def catchments():
    """Write site/public/data/catchments.bin (blobs and spiderwebs)."""
    export_mod.catchments()


@app.command()
def basemap():
    """Extract the study-area basemap from the Protomaps build in sources.toml."""
    export_mod.basemap()


@app.command()
def fit():
    """Fit the score to observed boardings (after `sql 70_validation`): valid.fit_params,
    valid.stop_fit and data/build/validation/ridership.md."""
    fit_mod.fit()


if __name__ == "__main__":
    app()
