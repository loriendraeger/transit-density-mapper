"""Transit accessibility with R5 (r5py): what each stop connects to by riding.

Travel time = walk to a stop, wait, ride (with transfers), walk to the destination, for
every departure minute in a weekday morning window ([access] in pipeline.toml),
summarized as percentiles: the median is the rider who shows up at random (waits about
half the headway); low percentiles are the rider who plans around the schedule (R5 /
Conveyal practice; the fit picks the percentile).

- Forward, stop -> places: from each merged stop to every 150 m hex (gen.hex): jobs,
  other destinations (OSM points, shop and clinic jobs) and homes reachable.
- Reverse, homes -> stop: from populated areas to each stop (how many people can get
  here). Origins are coarser cells ([access] reverse_cell_m, population-weighted
  centers), as usual for many-origin routing.

R5 only reruns when its inputs change (street network, GTFS, origin and destination
points, settings): matrices are cached in data/build/r5/ by a hash of them. Outputs:

- catch.access_times: stop x hex travel times (minutes) per percentile, for isochrones
- catch.access_bands: per stop, percentile and travel-time band ([access] band_min),
  the hexes' totals of each measure (pop, jobs, osm, shopjobs) reached in that band
- catch.access_rev_bands: per stop, percentile and band, residents who reach the stop
"""

import datetime
import hashlib
import json
import sys
import zipfile

import numpy as np
import psycopg

from . import config

R5_DIR = config.BUILD / "r5"
MEASURES = ("pop", "jobs", "osm", "shopjobs")


def _gtfs_zip() -> str:
    """The GTFS feed without its empty tables (R5 rejects a table with only a header)."""
    src_path = config.REPO / config.sources()["gtfs"]["local_path"]
    src_path = src_path.with_suffix(".zip") if src_path.suffix != ".zip" else src_path
    out = R5_DIR / "gtfs.zip"
    with zipfile.ZipFile(src_path) as src, zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as dst:
        for info in sorted(src.infolist(), key=lambda i: i.filename):
            data = src.read(info)
            if len(data.strip().splitlines()) > 1:
                # Fixed timestamps: the same feed gives the same bytes (and cache key).
                zi = zipfile.ZipInfo(info.filename, date_time=(1980, 1, 1, 0, 0, 0))
                zi.compress_type = zipfile.ZIP_DEFLATED
                dst.writestr(zi, data)
    return str(out)


def _osm_pbf() -> str:
    """The OSM extract clipped to the study area (R5 builds its street network from it)."""
    import subprocess

    src = config.REPO / config.sources()["osm"]["local_path"]
    out = R5_DIR / "study.osm.pbf"
    bbox = ",".join(str(v) for v in config.pipeline()["study_area"]["bbox_4326"])
    subprocess.run(
        ["osmium", "extract", "-b", bbox, str(src), "-o", str(out), "--overwrite"],
        check=True,
    )
    return str(out)


def _points(conn) -> dict:
    a = config.pipeline()["access"]
    stops = conn.execute(
        "SELECT cluster_id, ST_X(ST_Transform(geom, 4326)), ST_Y(ST_Transform(geom, 4326)) "
        "FROM transit.clusters ORDER BY cluster_id"
    ).fetchall()
    hexes = conn.execute(
        "SELECT id, ST_X(ST_Transform(ST_Centroid(geom), 4326)), "
        "ST_Y(ST_Transform(ST_Centroid(geom), 4326)), pop, jobs, dest, shop_jobs "
        "FROM gen.hex ORDER BY id"
    ).fetchall()
    # Reverse origins: populated hexes grouped into coarser hex cells, each at the
    # population-weighted center of its hexes.
    cells = conn.execute(
        """
        WITH grid AS (
            SELECT row_number() OVER ()::int AS id, h.geom
            FROM ST_HexagonGrid(%s / sqrt(3),
                 ST_Transform(ST_MakeEnvelope(%s, %s, %s, %s, 4326), %s)) h
        ),
        m AS (
            SELECT g.id, x.pop, ST_Centroid(x.geom) AS c
            FROM gen.hex x JOIN grid g ON ST_Intersects(g.geom, ST_Centroid(x.geom))
            WHERE x.pop > 0
        )
        SELECT id, ST_X(p), ST_Y(p), pop FROM (
            SELECT id, sum(pop) AS pop,
                   ST_Transform(ST_SetSRID(ST_MakePoint(sum(ST_X(c) * pop) / sum(pop),
                                                        sum(ST_Y(c) * pop) / sum(pop)),
                                           %s), 4326) AS p
            FROM m GROUP BY id
        ) s ORDER BY id
        """,
        (
            a["reverse_cell_m"],
            *config.pipeline()["study_area"]["bbox_4326"],
            config.setting("crs"),
            config.setting("crs"),
        ),
    ).fetchall()
    return {"stops": stops, "hexes": hexes, "cells": cells}


def _key(*parts) -> str:
    h = hashlib.sha256()
    for p in parts:
        h.update(p if isinstance(p, bytes) else json.dumps(p, sort_keys=True).encode())
    return h.hexdigest()[:16]


def _matrix(net_files, origins, destinations, label: str) -> dict:
    """Travel times origin x destination (minutes, -1 = not within max_time) for each
    percentile, from the cache or R5."""
    a = config.pipeline()["access"]
    params = {
        k: a[k]
        for k in ("departure_hour", "window_hours", "access_max_minutes", "access_percentiles")
    }
    params["walk_kmh"] = config.pipeline()["walk"]["walk_speed_mps"] * 3.6
    params["date"] = net_files["date"]
    key = _key(
        net_files["hash"],
        params,
        [(o[0], round(o[1], 6), round(o[2], 6)) for o in origins],
        [(d[0], round(d[1], 6), round(d[2], 6)) for d in destinations],
    )
    path = R5_DIR / f"{label}_{key}.npz"
    if path.exists():
        print(f"{label}: cached travel times ({path.name})", flush=True)
        return dict(np.load(path))

    # r5py reads its settings (Java heap) from the command line when imported.
    sys.argv = [sys.argv[0], "--max-memory", a["java_memory"]]
    import geopandas as gpd
    import r5py
    import shapely

    def gdf(rows):
        return gpd.GeoDataFrame(
            {"id": [str(r[0]) for r in rows]},
            geometry=[shapely.Point(r[1], r[2]) for r in rows],
            crs="EPSG:4326",
        )

    net = r5py.TransportNetwork(net_files["osm"], [net_files["gtfs"]])
    print(f"{label}: routing {len(origins)} origins x {len(destinations)} destinations", flush=True)
    d = datetime.date.fromisoformat(net_files["date"])
    ttm = r5py.TravelTimeMatrix(
        net,
        origins=gdf(origins),
        destinations=gdf(destinations),
        departure=datetime.datetime(d.year, d.month, d.day, a["departure_hour"]),
        departure_time_window=datetime.timedelta(hours=a["window_hours"]),
        percentiles=a["access_percentiles"],
        transport_modes=[r5py.TransportMode.TRANSIT, r5py.TransportMode.WALK],
        max_time=datetime.timedelta(minutes=a["access_max_minutes"]),
        speed_walking=params["walk_kmh"],
    )
    o_idx = {str(o[0]): i for i, o in enumerate(origins)}
    d_idx = {str(x[0]): i for i, x in enumerate(destinations)}
    out = {
        "o": ttm["from_id"].map(o_idx).to_numpy(np.int32),
        "d": ttm["to_id"].map(d_idx).to_numpy(np.int32),
    }
    for p in a["access_percentiles"]:
        out[f"p{p}"] = ttm[f"travel_time_p{p}"].fillna(-1).to_numpy(np.int16)
    keep = np.zeros(len(out["o"]), bool)
    for p in a["access_percentiles"]:
        keep |= out[f"p{p}"] >= 0
    out = {k: v[keep] for k, v in out.items()}
    for old in R5_DIR.glob(f"{label}_*.npz"):
        old.unlink()
    np.savez_compressed(path, **out)
    return out


def _bands(m: dict, n_origins: int, values: np.ndarray, pct: int, band_min: int, n_bands: int):
    """Sum of destination values per origin and travel-time band (band b = [b*w, (b+1)*w)
    minutes, so band 0 includes 0)."""
    t = m[f"p{pct}"]
    ok = t >= 0
    band = np.minimum(t[ok] // band_min, n_bands - 1)
    out = np.zeros((n_origins, n_bands, values.shape[1]))
    np.add.at(out, (m["o"][ok], band), values[m["d"][ok]])
    return out


def access() -> None:
    a = config.pipeline()["access"]
    R5_DIR.mkdir(parents=True, exist_ok=True)
    with psycopg.connect("") as conn:
        pts = _points(conn)
        date = conn.execute(
            "SELECT date::text FROM transit.rep_dates WHERE day_type = 'weekday'"
        ).fetchone()[0]
    files = {"osm": _osm_pbf(), "gtfs": _gtfs_zip(), "date": date}
    h = hashlib.sha256()
    for f in (files["osm"], files["gtfs"]):
        h.update(open(f, "rb").read())
    files["hash"] = h.hexdigest()

    stops, hexes, cells = pts["stops"], pts["hexes"], pts["cells"]
    fwd = _matrix(files, stops, hexes, "forward")
    rev = _matrix(files, cells, stops, "reverse")

    n_bands = a["access_max_minutes"] // a["access_band_min"]
    hex_vals = np.array([[r[3], r[4], r[5], r[6]] for r in hexes], float)
    cell_pop = np.array([[r[3]] for r in cells], float)
    stop_ids = [s[0] for s in stops]
    with psycopg.connect("") as conn:
        conn.execute(
            "DROP TABLE IF EXISTS catch.access_times, catch.access_bands, catch.access_rev_bands"
        )
        cols = ", ".join(f"p{p} smallint" for p in a["access_percentiles"])
        conn.execute(f"CREATE TABLE catch.access_times (cluster_id text, hex_id int, {cols})")
        with conn.cursor().copy("COPY catch.access_times FROM STDIN") as cp:
            hex_ids = [r[0] for r in hexes]
            pcols = [fwd[f"p{p}"] for p in a["access_percentiles"]]
            for i in range(len(fwd["o"])):
                cp.write_row(
                    [stop_ids[fwd["o"][i]], hex_ids[fwd["d"][i]]]
                    + [int(c[i]) if c[i] >= 0 else None for c in pcols]
                )
        conn.execute(
            "CREATE TABLE catch.access_bands (cluster_id text, pct int, band int, "
            "measure text, value float8)"
        )
        conn.execute(
            "CREATE TABLE catch.access_rev_bands (cluster_id text, pct int, band int, value float8)"
        )
        with (
            conn.cursor().copy("COPY catch.access_bands FROM STDIN") as cp,
        ):
            for p in a["access_percentiles"]:
                b = _bands(fwd, len(stops), hex_vals, p, a["access_band_min"], n_bands)
                for i, j, k in zip(*np.nonzero(b), strict=True):
                    cp.write_row([stop_ids[i], p, int(j), MEASURES[k], float(b[i, j, k])])
        # Reverse: origins are cells, destinations stops; sum cell residents per stop.
        rev_t = {
            "o": rev["d"],
            "d": rev["o"],
            **{f"p{p}": rev[f"p{p}"] for p in a["access_percentiles"]},
        }
        with conn.cursor().copy("COPY catch.access_rev_bands FROM STDIN") as cp:
            for p in a["access_percentiles"]:
                b = _bands(rev_t, len(stops), cell_pop, p, a["access_band_min"], n_bands)
                for i, j, _ in zip(*np.nonzero(b), strict=True):
                    cp.write_row([stop_ids[i], p, int(j), float(b[i, j, 0])])
        conn.execute("CREATE INDEX ON catch.access_times (cluster_id)")
    print(
        f"access: {len(fwd['o'])} stop-hex pairs, {len(rev['o'])} cell-stop pairs "
        f"({len(cells)} reverse origin cells)"
    )
