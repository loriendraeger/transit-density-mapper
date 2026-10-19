"""`transit <command>`: the pipeline entry point, called by the Makefile."""

from typing import Annotated

import typer

from . import download as download_mod
from . import export as export_mod
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
def export(
    only: Annotated[
        list[str] | None, typer.Option(help="just these stops' catchment files")
    ] = None,
):
    """Write site/public/data/: tiles, stops.json, catchments/<stop>.json."""
    if only:
        export_mod.catchments(only=only)
        return
    export_mod.tiles()
    export_mod.stops_json()
    export_mod.catchments()


@app.command()
def basemap():
    """Extract the study-area basemap from the Protomaps build in sources.toml."""
    export_mod.basemap()


if __name__ == "__main__":
    app()
