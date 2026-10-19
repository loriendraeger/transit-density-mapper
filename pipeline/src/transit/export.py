"""Products for the site (site/public/data/):

- <file>.pmtiles   tile layers from the `export` schema views (GeoJSONSeq -> tippecanoe)
- stops.json       every merged stop: frequencies, banded catchment totals, metadata
- catchments/<id>.json   per stop: the spiderweb (walk-network edge ids + walk times)
                   and the blob (one polygon per minute band), loaded when a stop is
                   selected
- basemap.pmtiles  Protomaps extract of the study area

Shapes must match site/src/lib/contract.ts.
"""

import datetime
import json
import math
import shutil
import subprocess
from multiprocessing import Pool
from pathlib import Path

import numpy as np
import psycopg
import shapely
from psycopg.rows import dict_row
from shapely import wkb
from shapely.ops import substring

from . import config

EXPORT_DIR = config.BUILD / "export"
SITE_DATA = config.SITE_DATA
CATCH_DIR = SITE_DATA / "catchments"
# Coordinates in catchment files: integer units of 1e-5 degrees (~1 m), delta-encoded.
COORD_SCALE = 100_000
PERIODS = ["peak", "offpeak", "saturday", "sunday"]
DAY_TYPES = ["weekday", "saturday", "sunday"]
HOURS = 28  # service days run past midnight (hour 24+)


def run(cmd: list[str]) -> None:
    print("+", " ".join(cmd), flush=True)
    subprocess.run(cmd, check=True)


# --- tiles -------------------------------------------------------------------------


def export_view(view: str) -> Path:
    EXPORT_DIR.mkdir(parents=True, exist_ok=True)
    out = EXPORT_DIR / f"{view}.geojsonl"
    out.unlink(missing_ok=True)
    run(
        [
            "ogr2ogr",
            "-f",
            "GeoJSONSeq",
            str(out),
            "PG:",
            f"export.{view}",
            "-lco",
            "COORDINATE_PRECISION=6",
        ]
    )
    return out


def tiles() -> None:
    files = config.pipeline()["tiles"]["files"]
    attribution = config.pipeline()["tiles"]["attribution"]
    SITE_DATA.mkdir(parents=True, exist_ok=True)
    for name, spec in files.items():
        cmd = [
            "tippecanoe",
            "-o",
            str(SITE_DATA / f"{name}.pmtiles"),
            "--force",
            "--quiet",
            "-Z",
            str(spec["minzoom"]),
            "-z",
            str(spec["maxzoom"]),
            "--no-feature-limit",
            "--no-tile-size-limit",
            # Feature ids let the site color the spiderweb with feature-state.
            "--use-attribute-for-id=id",
            "--attribution",
            attribution,
        ]
        for layer in spec["layers"]:
            cmd += ["-L", f"{layer}:{export_view(layer)}"]
        run(cmd)


# --- stops.json --------------------------------------------------------------------


def _measures(conn) -> list[dict]:
    cats = conn.execute(
        "SELECT category, count(*) AS n, round(sum(weight)::numeric, 1)::float8 AS weight "
        "FROM gen.pois GROUP BY category ORDER BY category"
    ).fetchall()
    return [
        {"id": "pop", "kind": "pop", "label": "Population"},
        {"id": "jobs", "kind": "jobs", "label": "Jobs"},
        *(
            {
                "id": c["category"],
                "kind": "poi",
                "label": c["category"].capitalize(),
                "count": c["n"],
            }
            for c in cats
        ),
    ]


def stops_json() -> None:
    p = config.pipeline()
    with psycopg.connect("", row_factory=dict_row) as conn:
        measures = _measures(conn)
        measure_ids = [m["id"] for m in measures]
        n_bands = math.ceil(p["walk"]["max_walk_min"] / p["walk"]["band_min"])
        clusters = conn.execute(
            """
            SELECT c.cluster_id AS id, c.name, c.stop_codes AS codes, c.stop_ids,
                   round(ST_X(ST_Transform(c.geom, 4326))::numeric, 6)::float8 AS lon,
                   round(ST_Y(ST_Transform(c.geom, 4326))::numeric, 6)::float8 AS lat,
                   coalesce(d.one_way, false) AS one_way,
                   round(d.spread_deg)::int AS spread_deg
            FROM transit.clusters c
            LEFT JOIN transit.directionality d USING (cluster_id)
            WHERE EXISTS (SELECT 1 FROM catch.reach r WHERE r.cluster_id = c.cluster_id)
            ORDER BY c.cluster_id
            """
        ).fetchall()
        by_id = {c["id"]: c for c in clusters}
        for c in clusters:
            c["routes"] = []
            c["freq"] = {}
            c["hourly"] = {d: [0] * HOURS for d in DAY_TYPES}
            c["bands"] = {m: [0] * n_bands for m in measure_ids}
        for r in conn.execute(
            "SELECT cluster_id, period, route_id, trips_per_hour FROM transit.period_freq"
        ):
            c = by_id.get(r["cluster_id"])
            if c is not None:
                c["freq"].setdefault(r["period"], {})[r["route_id"]] = round(r["trips_per_hour"], 2)
        for r in conn.execute(
            "SELECT cluster_id, day_type, hour, sum(departures)::int AS n, "
            "array_agg(DISTINCT route_id) AS routes "
            "FROM transit.hourly GROUP BY 1, 2, 3"
        ):
            c = by_id.get(r["cluster_id"])
            if c is not None and r["hour"] < HOURS:
                c["hourly"][r["day_type"]][r["hour"]] = r["n"]
                c["routes"] = sorted(set(c["routes"]) | set(r["routes"]))
        for r in conn.execute("SELECT cluster_id, band, measure, value FROM catch.bands"):
            c = by_id.get(r["cluster_id"])
            if c is not None and r["band"] <= n_bands:
                c["bands"][r["measure"]][r["band"] - 1] = round(r["value"], 1)
        routes = conn.execute(
            "SELECT route_id AS id, route_short_name AS name, route_color AS color, "
            "route_text_color AS text_color, route_desc AS description, sort_order "
            "FROM staging.routes ORDER BY sort_order, route_id"
        ).fetchall()
        rep = conn.execute("SELECT day_type, date::text AS date FROM transit.rep_dates").fetchall()
        feed = conn.execute(
            "SELECT min(start_date)::text AS start, max(end_date)::text AS end "
            "FROM staging.calendar"
        ).fetchone()
        pois = conn.execute(
            "SELECT category, kind, count(*) AS n FROM gen.pois GROUP BY 1, 2 ORDER BY 1, 3 DESC"
        ).fetchall()

    f = p["frequency"]
    src = config.sources()
    out = {
        "generated": datetime.date.today().isoformat(),
        "feed": feed,
        "rep_dates": {r["day_type"]: r["date"] for r in rep},
        "settings": {
            "walk_speed_mps": p["walk"]["walk_speed_mps"],
            "max_walk_min": p["walk"]["max_walk_min"],
            "band_min": p["walk"]["band_min"],
            "one_way_factor": f["one_way_factor"],
            "one_way_spread_deg": f["one_way_spread_deg"],
            "cluster_max_diameter_m": p["stops"]["cluster_max_diameter_m"],
            "periods": {
                "peak": {
                    "day_type": "weekday",
                    "hours": f["peak_hours"],
                    "weight": f["weight_peak"],
                },
                "offpeak": {
                    "day_type": "weekday",
                    "hours": f["offpeak_hours"],
                    "weight": f["weight_offpeak"],
                },
                "saturday": {
                    "day_type": "saturday",
                    "hours": f["saturday_hours"],
                    "weight": f["weight_saturday"],
                },
                "sunday": {
                    "day_type": "sunday",
                    "hours": f["sunday_hours"],
                    "weight": f["weight_sunday"],
                },
            },
        },
        "sources": {
            name: {
                "name": s["name"],
                "url": s.get("landing", s["url"]),
                "retrieved": s["retrieved"],
                "attribution": s.get("attribution", ""),
            }
            for name, s in src.items()
        },
        "measures": measures,
        "poi_kinds": pois,
        "routes": routes,
        "stops": clusters,
    }
    SITE_DATA.mkdir(parents=True, exist_ok=True)
    path = SITE_DATA / "stops.json"
    path.write_text(json.dumps(out, separators=(",", ":"), ensure_ascii=False))
    size = path.stat().st_size / 1e6
    print(f"wrote {path.relative_to(config.REPO)}: {len(clusters)} stops, {size:.1f} MB")


# --- per-stop catchment files ------------------------------------------------------


def _encode_ring(coords: np.ndarray) -> list[int]:
    """Ring -> flat [x0, y0, dx1, dy1, ...] in integer 1e-5 degrees."""
    q = np.round(coords[:, :2] * COORD_SCALE).astype(np.int64)
    d = np.vstack([q[:1], np.diff(q, axis=0)])
    return d.ravel().tolist()


def _encode(geom) -> list[list[list[int]]]:
    polys = [geom] if geom.geom_type == "Polygon" else list(getattr(geom, "geoms", []))
    return [
        [_encode_ring(np.asarray(p.exterior.coords))]
        + [_encode_ring(np.asarray(r.coords)) for r in p.interiors]
        for p in polys
        if not p.is_empty
    ]


def _catchment(cid: str) -> int:
    p = config.pipeline()
    max_s = p["walk"]["max_walk_min"] * 60
    band_s = p["walk"]["band_min"] * 60
    c = p["catchments"]
    with psycopg.connect("") as conn:
        rows = conn.execute(
            """
            SELECT e.osm_edge, ST_AsBinary(e.geom), et.ts, et.tt, e.cost
            FROM catch.edge_time et JOIN net.edges e ON e.id = et.edge_id
            WHERE et.cluster_id = %s AND e.kind <> 'cross'
            """,
            (cid,),
        ).fetchall()

    geoms = [wkb.loads(r[1]) for r in rows]
    ts = np.array([r[2] if r[2] is not None else np.inf for r in rows])
    tt = np.array([r[3] if r[3] is not None else np.inf for r in rows])
    cost = np.maximum(np.array([r[4] for r in rows]), 1e-9)

    # Spiderweb: each OSM edge's earliest walk time, in whole seconds.
    edge_t: dict[int, float] = {}
    for r, a, b in zip(rows, ts, tt, strict=True):
        t = min(a, b)
        if r[0] is not None and t <= max_s and t < edge_t.get(r[0], np.inf):
            edge_t[r[0]] = t
    ids = sorted(edge_t)
    id_deltas = np.diff(np.array([0, *ids])).tolist()
    times = [int(round(edge_t[i])) for i in ids]

    # Blob: cumulative polygons for each band.
    bands = []
    for b in range(1, math.ceil(max_s / band_s) + 1):
        limit = b * band_s
        fa = np.clip((limit - ts) / cost, 0, 1)
        fb = np.clip((limit - tt) / cost, 0, 1)
        pieces = []
        for g, x, y in zip(geoms, fa, fb, strict=True):
            if x + y >= 1:
                pieces.append(g)
            else:
                if x > 0:
                    pieces.append(substring(g, 0, x, normalized=True))
                if y > 0:
                    pieces.append(substring(g, 1 - y, 1, normalized=True))
        if not pieces:
            bands.append(shapely.Polygon())
            continue
        u = shapely.union_all(shapely.buffer(pieces, c["blob_buffer_m"], quad_segs=2))
        u = shapely.buffer(
            shapely.buffer(u, c["blob_close_m"], quad_segs=2), -c["blob_close_m"], quad_segs=2
        )
        bands.append(shapely.simplify(u, c["blob_simplify_m"]))

    # Project all bands to lon/lat in one round trip.
    with psycopg.connect("") as conn:
        crs = config.setting("crs")
        projected = conn.execute(
            "SELECT ST_AsBinary(ST_Transform(ST_SetSRID(ST_GeomFromWKB(g), %s), 4326)) "
            "FROM unnest(%s::bytea[]) WITH ORDINALITY AS u(g, i) ORDER BY i",
            (crs, [shapely.to_wkb(g) for g in bands]),
        ).fetchall()
    out = {
        "id": cid,
        "edges": {"id_deltas": id_deltas, "t": times},
        "bands": [_encode(wkb.loads(bytes(r[0]))) for r in projected],
    }
    path = CATCH_DIR / f"{cid}.json"
    path.write_text(json.dumps(out, separators=(",", ":")))
    return path.stat().st_size


def catchments(workers: int = 12, only: list[str] | None = None) -> None:
    with psycopg.connect("") as conn:
        ids = only or [
            r[0]
            for r in conn.execute(
                "SELECT DISTINCT cluster_id FROM catch.reach ORDER BY 1"
            ).fetchall()
        ]
    if only is None and CATCH_DIR.exists():
        shutil.rmtree(CATCH_DIR)
    CATCH_DIR.mkdir(parents=True, exist_ok=True)
    total = 0
    with Pool(workers) as pool:
        for i, size in enumerate(pool.imap_unordered(_catchment, ids), 1):
            total += size
            if i % 100 == 0:
                print(f"  {i}/{len(ids)} catchments", flush=True)
    print(f"wrote {len(ids)} catchment files, {total / 1e6:.1f} MB")


# --- basemap -----------------------------------------------------------------------


def basemap() -> None:
    """Protomaps extract of the study area bbox (HTTP range requests; only the needed
    tiles are downloaded)."""
    b = config.sources()["basemap"]
    t = config.pipeline()["tiles"]
    bbox = ",".join(map(str, config.pipeline()["study_area"]["bbox_4326"]))
    SITE_DATA.mkdir(parents=True, exist_ok=True)
    run(
        [
            "pmtiles",
            "extract",
            b["url"],
            str(SITE_DATA / "basemap.pmtiles"),
            f"--bbox={bbox}",
            f"--maxzoom={t['basemap_maxzoom']}",
        ]
    )
