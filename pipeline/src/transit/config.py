"""Load config/*.toml. config/ is the single source of truth for tunables."""

import tomllib
from functools import cache
from pathlib import Path

# The repo is mounted at /work in the pipeline container; find it relative to this file
# so the CLI also works from a checkout on the host.
REPO = Path(__file__).resolve().parents[3]
CONFIG = REPO / "config"
SQL_DIR = REPO / "pipeline" / "sql"
BUILD = REPO / "data" / "build"
SITE_DATA = REPO / "site" / "public" / "data"


@cache
def pipeline() -> dict:
    return tomllib.loads((CONFIG / "pipeline.toml").read_text())


@cache
def sources() -> dict:
    return tomllib.loads((CONFIG / "sources.toml").read_text())


def setting(key: str):
    """A pipeline.toml value by key, whatever its section (keys are unique)."""
    for values in pipeline().values():
        if key in values:
            return values[key]
    raise KeyError(f"{key!r} not in config/pipeline.toml")


def psql_vars() -> dict[str, str]:
    """Flatten pipeline.toml into psql variables: [analysis] crs -> :crs.

    Keys must be unique across sections. Lists become comma-separated strings, which SQL
    splits with string_to_array(:'name', ',').
    """
    out: dict[str, str] = {}
    for section, values in pipeline().items():
        for key, value in values.items():
            if isinstance(value, dict):
                continue  # nested tables are Python-only config
            if key in out:
                raise ValueError(f"duplicate config key {key!r} (in [{section}])")
            if isinstance(value, list):
                value = ",".join(str(v) for v in value)
            elif isinstance(value, bool):
                value = "true" if value else "false"
            out[key] = str(value)
    return out
