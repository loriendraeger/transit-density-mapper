"""Load raw downloads into the PostGIS `raw` schema.

Raw tables keep the source's CRS and attributes; cleaning and reprojection happen in
sql/10_staging/. Vector files go through ogr2ogr, GTFS and LODES through COPY, and OSM
through pyosmium (osm.py).
"""

import csv
import gzip
import subprocess

import psycopg

from . import config
from .osm import load_osm

PG = "PG:"
COMMON = [
    "-overwrite",
    "-lco",
    "GEOMETRY_NAME=geom",
    "-lco",
    "FID=fid",
    "-lco",
    "SPATIAL_INDEX=GIST",
    "-lco",
    "PRECISION=NO",
    "--config",
    "PG_USE_COPY",
    "YES",
]
GTFS_FILES = [
    "stops",
    "routes",
    "trips",
    "stop_times",
    "calendar",
    "calendar_dates",
    "shapes",
]


def run(cmd: list[str]) -> None:
    print("+", " ".join(cmd), flush=True)
    subprocess.run(cmd, check=True)


def load_vector(src: dict) -> None:
    path = config.REPO / src["local_path"]
    cmd = ["ogr2ogr", "-f", "PostgreSQL", PG, str(path)]
    if src.get("layer"):
        cmd.append(src["layer"])
    cmd += ["-nln", f"raw.{src['table']}", "-nlt", "PROMOTE_TO_MULTI", "-dim", "XY"]
    # Only what's inside the study area (the statewide files are large).
    cmd += ["-spat", *map(str, config.pipeline()["study_area"]["bbox_4326"])]
    cmd += ["-spat_srs", "EPSG:4326"]
    run(cmd + COMMON)


def load_gtfs(src: dict) -> None:
    """Every GTFS file -> raw.gtfs_<file>, all columns text (staging casts)."""
    folder = config.REPO / src["local_path"]
    with psycopg.connect("") as conn:
        conn.execute("CREATE SCHEMA IF NOT EXISTS raw")
        for name in GTFS_FILES:
            path = folder / f"{name}.txt"
            # utf-8-sig: Metro's files start with a byte-order mark.
            with open(path, encoding="utf-8-sig", newline="") as f:
                reader = csv.reader(f)
                header = next(reader)
                cols = ", ".join(f'"{c.strip()}" text' for c in header)
                table = f"raw.gtfs_{name}"
                conn.execute(f"DROP TABLE IF EXISTS {table}; CREATE TABLE {table} ({cols})")
                with conn.cursor().copy(f"COPY {table} FROM STDIN") as cp:
                    for row in reader:
                        cp.write_row([v if v != "" else None for v in row])
            print(f"loaded {table}")


def load_lodes(src: dict) -> None:
    path = config.REPO / src["local_path"]
    with gzip.open(path, "rt", newline="") as f, psycopg.connect("") as conn:
        reader = csv.reader(f)
        header = next(reader)
        cols = ", ".join(
            f"{c.lower()} text" if c in ("w_geocode", "createdate") else f"{c.lower()} int"
            for c in header
        )
        conn.execute(f"DROP TABLE IF EXISTS raw.{src['table']}")
        conn.execute(f"CREATE TABLE raw.{src['table']} ({cols})")
        with conn.cursor().copy(f"COPY raw.{src['table']} FROM STDIN") as cp:
            for row in reader:
                cp.write_row(row)
    print(f"loaded raw.{src['table']}")


def load(names: list[str] | None = None) -> None:
    sources = {k: v for k, v in config.sources().items() if v.get("table")}
    # By default, everything the site is built from; validation data loads on request.
    default = [k for k, v in sources.items() if v.get("purpose") != "validation"]
    for name in names or default:
        src = sources[name]
        path = config.REPO / src["local_path"]
        if not path.exists():
            raise FileNotFoundError(f"[{name}] {path} is missing; run `transit download`")
        if name == "gtfs":
            load_gtfs(src)
        elif name == "lodes":
            load_lodes(src)
        elif name == "osm":
            load_osm(path)
        else:
            load_vector(src)
