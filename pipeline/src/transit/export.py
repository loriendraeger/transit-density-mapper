"""Products for the site (site/public/data/):

- <file>.pmtiles   tile layers from the `export` schema views (GeoJSONSeq -> tippecanoe)
- stops.json       every merged stop: frequencies, banded catchment totals, metadata
- catchments.bin  every stop's spiderweb (walk-network edge ids + walk times) and blob
                   (one polygon per minute band) in one indexed binary file; the site
                   fetches just the selected stop's bytes (HTTP range request)
- basemap.pmtiles  Protomaps extract of the study area

Shapes must match site/src/lib/contract.ts.
"""

import datetime
import json
import math
import struct
import subprocess
import zlib
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
CATCH_FILE = SITE_DATA / "catchments.bin"
# catchments.bin layout (little-endian; read by site/src/lib/catchment.ts):
#   "TDMC" | u16 version | u32 index length | index (UTF-8 JSON) | records...
# The index maps stop id -> [byte offset, byte length] of its record, so the site can
# fetch one stop with an HTTP range request (like PMTiles does for tiles). A record is a
# raw-deflate stream of unsigned LEB128 varints:
#   n_edges, edge id deltas (ascending ids)..., then n_edges bytes of walk time / 10 s,
#   n_bands, per band: n_polygons, per polygon: n_rings, per ring: n_points, then
#   2 x n_points zigzag varints (x, y in 1e-5 degrees, delta-encoded; first absolute).
CATCH_MAGIC = b"TDMC"
CATCH_VERSION = 1
TIME_STEP_S = 10
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


def tiles(names: list[str] | None = None) -> None:
    """Build site/public/data/<name>.pmtiles for each [tiles.files] entry (default: all)."""
    files = config.pipeline()["tiles"]["files"]
    attribution = config.pipeline()["tiles"]["attribution"]
    unknown = set(names or []) - set(files)
    if unknown:
        raise SystemExit(f"unknown tile file(s) {sorted(unknown)}; choose from {list(files)}")
    SITE_DATA.mkdir(parents=True, exist_ok=True)
    for name, spec in files.items():
        if names and name not in names:
            continue
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
        {"id": "pop", "kind": "pop", "label": "Homes"},
        {"id": "jobs", "kind": "jobs", "label": "Jobs"},
        {"id": "shopjobs", "kind": "shopjobs", "label": "Retail and health-care jobs"},
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
                   round(ST_Y(ST_Transform(c.geom, 4326))::numeric, 6)::float8 AS lat
            FROM transit.clusters c
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
            c["riders"] = None
            c["special"] = []
            c["overlap"] = None
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
        # Observed vs. expected weekday boardings (fit.py) and special-stop reasons.
        for r in conn.execute(
            "SELECT f.cluster_id, f.boardings, f.expected, f.in_fit, s.reasons "
            "FROM valid.stop_fit f LEFT JOIN valid.special s USING (cluster_id)"
        ):
            c = by_id.get(r["cluster_id"])
            if c is not None:
                c["riders"] = (
                    None
                    if r["boardings"] is None
                    else {
                        "observed": round(r["boardings"], 1),
                        "expected": round(r["expected"], 1),
                    }
                )
                c["special"] = r["reasons"] or []
        shares = conn.execute(
            "SELECT grp, round(share::numeric, 4)::float8 AS share FROM gen.purpose_shares "
            "ORDER BY share DESC"
        ).fetchall()
        # What each stop adds over the next-best stop on its routes (55_catchments/
        # 20_overlap.sql), per measure group: decay-weighted full and added totals at the
        # default settings, and residents in reach / who'd walk 2+ minutes more without it.
        for r in conn.execute(
            "SELECT cluster_id, CASE WHEN measure IN ('pop', 'jobs', 'shopjobs') THEN measure "
            "ELSE 'poi' END AS grp, sum(full_value) AS full_value, sum(added) AS added, "
            "sum(in_reach) AS in_reach, sum(coalesce(far_without, 0)) AS far_without "
            "FROM catch.marginal GROUP BY 1, 2"
        ):
            c = by_id.get(r["cluster_id"])
            if c is None:
                continue
            if c["overlap"] is None:
                c["overlap"] = {"full": {}, "added": {}, "residents": 0, "residents_far": 0}
            o = c["overlap"]
            o["full"][r["grp"]] = round(r["full_value"], 2)
            o["added"][r["grp"]] = round(r["added"], 2)
            if r["grp"] == "pop":
                o["residents"] = round(r["in_reach"])
                o["residents_far"] = round(r["far_without"])
        fit = {
            r["key"]: r["value"] for r in conn.execute("SELECT key, value FROM valid.fit_params")
        }
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
            "cluster_max_diameter_m": p["stops"]["cluster_max_diameter_m"],
            # Fixed score settings ([score]) and default weights fit to observed
            # boardings (fit.py). Other destinations = POI points + shop_jobs_weight x
            # retail/health-care jobs.
            "score": {
                "walk_min": int(fit["walk_min"]),
                "half_life_min": fit["half_life"],
                "weights": {"pop": fit["w_pop"], "jobs": fit["w_jobs"], "dest": fit["w_dest"]},
                "shop_jobs_weight": round(fit["shop_jobs_weight"], 5),
                # The settings that predict boardings best (fit.py grid search).
                "best_fit": {
                    "walk_min": int(fit["best_walk_min"]),
                    "half_life_min": fit["best_half_life"],
                    "weights": {
                        "pop": fit["best_w_pop"],
                        "jobs": fit["best_w_jobs"],
                        "dest": fit["best_w_dest"],
                    },
                    "r2": round(fit["best_r2"], 3),
                    "cv_r2": round(fit["best_cv_r2"], 3),
                },
            },
            # Share of destination trips by purpose group (NHTS), which sets each
            # group's total destination points.
            "purpose_shares": {r["grp"]: r["share"] for r in shares},
            "fit": {
                "r2": round(fit["r2"], 3),
                "cv_r2": round(fit["cv_r2"], 3),
                "n_fit": int(fit["n_fit"]),
                "ratio_k": fit["ratio_k"],
            },
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


def _varint(out: bytearray, n: int) -> None:
    """Unsigned LEB128: 7 bits per byte, high bit = more bytes follow."""
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return


def _zigzag(n: int) -> int:
    """Signed -> unsigned so small negative deltas stay small (0, -1, 1, -2 -> 0, 1, 2, 3)."""
    return (n << 1) ^ (n >> 63)


def _pack_record(id_deltas: list[int], times: list[int], bands: list) -> bytes:
    out = bytearray()
    _varint(out, len(id_deltas))
    for d in id_deltas:
        _varint(out, d)
    out += bytes(min(255, round(t / TIME_STEP_S)) for t in times)
    _varint(out, len(bands))
    for polys in bands:
        _varint(out, len(polys))
        for rings in polys:
            _varint(out, len(rings))
            for ring in rings:
                _varint(out, len(ring) // 2)
                for v in ring:
                    _varint(out, _zigzag(v))
    z = zlib.compressobj(9, zlib.DEFLATED, -15)  # raw deflate (no zlib header)
    return z.compress(bytes(out)) + z.flush()


def _encode(geom) -> list[list[list[int]]]:
    polys = [geom] if geom.geom_type == "Polygon" else list(getattr(geom, "geoms", []))
    return [
        [_encode_ring(np.asarray(p.exterior.coords))]
        + [_encode_ring(np.asarray(r.coords)) for r in p.interiors]
        for p in polys
        if not p.is_empty
    ]


def _fill_holes(g, max_area: float):
    """Fill holes smaller than max_area (m²): a building or courtyard ringed by reached
    paths (no indoor paths in OSM) is reached, not a gap."""
    polys = [
        shapely.Polygon(p.exterior, [r for r in p.interiors if shapely.Polygon(r).area >= max_area])
        for p in getattr(g, "geoms", [g])
        if not p.is_empty
    ]
    return shapely.MultiPolygon(polys) if len(polys) > 1 else (polys[0] if polys else g)


def _catchment(cid: str) -> tuple[str, bytes]:
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
            ORDER BY e.id  -- the polygon union's float results depend on input order
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

    # Blob: cumulative polygons for each band. Most edges are fully reached in many
    # bands, so each edge is buffered once up front and reused; only the partly reached
    # pieces are cut and buffered per band. The union's input keeps the same order as
    # cutting and buffering everything per band (its float results depend on order).
    radius = c["blob_buffer_m"]
    full_buf = shapely.buffer(np.array(geoms, dtype=object), radius, quad_segs=2)
    bands = []
    for b in range(1, math.ceil(max_s / band_s) + 1):
        limit = b * band_s
        fa = np.clip((limit - ts) / cost, 0, 1)
        fb = np.clip((limit - tt) / cost, 0, 1)
        full = fa + fb >= 1
        bufs: list = []
        cut: list = []  # partly reached pieces, buffered below into their slots
        slots: list[int] = []
        for i in np.flatnonzero(full | (fa > 0) | (fb > 0)):
            if full[i]:
                bufs.append(full_buf[i])
                continue
            g = geoms[i]
            for piece in (
                substring(g, 0, fa[i], normalized=True) if fa[i] > 0 else None,
                substring(g, 1 - fb[i], 1, normalized=True) if fb[i] > 0 else None,
            ):
                if piece is not None:
                    slots.append(len(bufs))
                    bufs.append(None)
                    cut.append(piece)
        if not bufs:
            bands.append(shapely.Polygon())
            continue
        for slot, buf in zip(slots, shapely.buffer(cut, radius, quad_segs=2), strict=True):
            bufs[slot] = buf
        u = shapely.union_all(bufs)
        u = shapely.buffer(
            shapely.buffer(u, c["blob_close_m"], quad_segs=2), -c["blob_close_m"], quad_segs=2
        )
        u = _fill_holes(u, c["blob_fill_hole_ha"] * 1e4)
        bands.append(shapely.simplify(u, c["blob_simplify_m"]))

    # Project all bands to lon/lat in one round trip.
    with psycopg.connect("") as conn:
        crs = config.setting("crs")
        projected = conn.execute(
            "SELECT ST_AsBinary(ST_Transform(ST_SetSRID(ST_GeomFromWKB(g), %s), 4326)) "
            "FROM unnest(%s::bytea[]) WITH ORDINALITY AS u(g, i) ORDER BY i",
            (crs, [shapely.to_wkb(g) for g in bands]),
        ).fetchall()
    bands_enc = [_encode(wkb.loads(bytes(r[0]))) for r in projected]
    return cid, _pack_record(id_deltas, times, bands_enc)


def catchments(workers: int | None = None) -> None:
    """All stops' catchments in one binary file with an index (layout: CATCH_FILE)."""
    with psycopg.connect("") as conn:
        ids = [
            r[0]
            for r in conn.execute(
                "SELECT DISTINCT cluster_id FROM catch.reach ORDER BY 1"
            ).fetchall()
        ]
    records: dict[str, bytes] = {}
    # One process per CPU (Pool's default); blobs are CPU-bound Shapely work.
    with Pool(workers) as pool:
        for i, (cid, rec) in enumerate(pool.imap_unordered(_catchment, ids), 1):
            records[cid] = rec
            if i % 100 == 0:
                print(f"  {i}/{len(ids)} catchments", flush=True)

    # Offsets depend on the index's own length, which depends on the offsets' digits:
    # lay out with a guess, then repeat until the index length stops changing.
    order = sorted(records)
    index_len = 0
    while True:
        start = len(CATCH_MAGIC) + 2 + 4 + index_len
        entries, pos = {}, start
        for cid in order:
            entries[cid] = [pos, len(records[cid])]
            pos += len(records[cid])
        index = json.dumps(
            {
                "version": CATCH_VERSION,
                "scale": COORD_SCALE,
                "time_step_s": TIME_STEP_S,
                "stops": entries,
            },
            separators=(",", ":"),
        ).encode()
        if len(index) == index_len:
            break
        index_len = len(index)
    CATCH_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(CATCH_FILE, "wb") as f:
        f.write(CATCH_MAGIC + struct.pack("<HI", CATCH_VERSION, len(index)) + index)
        for cid in order:
            f.write(records[cid])
    (SITE_DATA / "catchments.json").unlink(missing_ok=True)  # the old format
    sizes = sorted(len(r) for r in records.values())
    print(
        f"wrote {CATCH_FILE.name}: {len(ids)} stops, {CATCH_FILE.stat().st_size / 1e6:.1f} MB "
        f"(index {len(index) / 1e3:.0f} kB; per stop median {sizes[len(sizes) // 2] / 1e3:.0f} kB, "
        f"max {sizes[-1] / 1e3:.0f} kB)"
    )


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
