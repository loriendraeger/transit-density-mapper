"""Walk times from every merged stop -> catch.reach (cluster_id, vertex, t seconds).

One pgRouting pgr_drivingDistance call per merged stop, starting from all of its
platforms at once (equicost: each vertex keeps the time from its nearest platform), out
to max_walk_min. Each call only loads edges within reach of the stop (a bbox of the
maximum walking distance), which keeps it ~0.1 s. Calls run in parallel connections.
"""

import time
from concurrent.futures import ThreadPoolExecutor

import psycopg

from . import config

WORKERS = 8

QUERY = """
INSERT INTO catch.reach (cluster_id, vertex, t)
SELECT %(cid)s, node, agg_cost
FROM pgr_drivingDistance(
    format($q$SELECT id, source, target, cost, cost AS reverse_cost FROM net.edges
             WHERE main AND geom && ST_Expand(%%L::geometry, %%s)$q$,
           (SELECT geom FROM transit.clusters WHERE cluster_id = %(cid)s), %(radius)s),
    (SELECT array_agg(DISTINCT vertex) FROM net.platform_vertex WHERE cluster_id = %(cid)s),
    %(max_s)s, directed => false, equicost => true)
"""


def _one(cid: str, params: dict) -> None:
    with psycopg.connect("", autocommit=True) as conn:
        conn.execute(QUERY, {"cid": cid, **params})


def reach() -> None:
    max_s = config.setting("max_walk_min") * 60
    # Straight-line reach of the longest walk, plus a margin for the platforms' spread.
    radius = max_s * config.setting("walk_speed_mps") + 300
    params = {"max_s": max_s, "radius": radius}
    with psycopg.connect("", autocommit=True) as conn:
        conn.execute(
            """
            DROP TABLE IF EXISTS catch.reach CASCADE;
            CREATE TABLE catch.reach (cluster_id text, vertex int, t real);
            """
        )
        ids = [
            r[0]
            for r in conn.execute(
                "SELECT DISTINCT cluster_id FROM net.platform_vertex ORDER BY 1"
            ).fetchall()
        ]
    start = time.monotonic()
    with ThreadPoolExecutor(WORKERS) as pool:
        for i, _ in enumerate(pool.map(lambda c: _one(c, params), ids), 1):
            if i % 100 == 0:
                print(f"  {i}/{len(ids)} stops, {time.monotonic() - start:.0f} s", flush=True)
    with psycopg.connect("", autocommit=True) as conn:
        conn.execute("CREATE INDEX ON catch.reach (cluster_id, vertex)")
        conn.execute("CREATE INDEX ON catch.reach (vertex)")
        conn.execute("ANALYZE catch.reach")
        n = conn.execute("SELECT count(*) FROM catch.reach").fetchone()[0]
    print(f"{len(ids)} stops, {n} reached vertices, {time.monotonic() - start:.0f} s")
