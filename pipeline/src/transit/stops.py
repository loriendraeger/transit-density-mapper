"""Merge nearby stops into clusters ("merged stops") -> transit.platform_cluster.

Complete-linkage hierarchical clustering: a group of stops merges only if *every* pair
in it is within cluster_max_diameter_m. Single linkage (what ST_ClusterDBSCAN does)
would chain stops along a dense street into one long cluster, since each stop is near
the next.

Hard constraints are folded into the distance matrix before clustering:
  - platforms of one GTFS parent_station (the BRT stations): distance 0;
  - config/stop_merge_overrides.csv `merge` rows: stops sharing a `group` get distance 0;
  - `split` rows: the stop is infinitely far from everything (its own cluster).
"""

import csv

import numpy as np
import psycopg
from scipy.cluster.hierarchy import fcluster, linkage
from scipy.spatial.distance import pdist, squareform

from . import config

FAR = 1e9


def overrides() -> list[dict]:
    with open(config.CONFIG / "stop_merge_overrides.csv") as f:
        return [r for r in csv.DictReader(f) if r.get("stop_id")]


def cluster() -> None:
    max_d = config.setting("cluster_max_diameter_m")
    with psycopg.connect("") as conn:
        rows = conn.execute(
            """
            SELECT s.stop_id, s.parent_station, ST_X(s.geom), ST_Y(s.geom)
            FROM staging.stops s
            WHERE coalesce(s.location_type, 0) = 0
              AND EXISTS (SELECT 1 FROM staging.stop_times t WHERE t.stop_id = s.stop_id)
            ORDER BY s.stop_id
            """
        ).fetchall()
        ids = [r[0] for r in rows]
        index = {s: i for i, s in enumerate(ids)}
        xy = np.array([[r[2], r[3]] for r in rows])
        d = squareform(pdist(xy))

        def tie(members: list[int]) -> None:
            for i in members:
                for j in members:
                    d[i, j] = 0

        parents: dict[str, list[int]] = {}
        for i, r in enumerate(rows):
            if r[1]:
                parents.setdefault(r[1], []).append(i)
        for members in parents.values():
            tie(members)

        groups: dict[str, list[int]] = {}
        for o in overrides():
            if o["stop_id"] not in index:
                print(f"warning: override for unknown or unused stop {o['stop_id']}")
                continue
            i = index[o["stop_id"]]
            if o["action"] == "merge":
                groups.setdefault(o["group"], []).append(i)
            elif o["action"] == "split":
                d[i, :] = FAR
                d[:, i] = FAR
                d[i, i] = 0
            else:
                raise SystemExit(f"stop_merge_overrides.csv: unknown action {o['action']!r}")
        for members in groups.values():
            tie(members)

        z = linkage(squareform(d, checks=False), method="complete")
        labels = fcluster(z, t=max_d, criterion="distance")

        # Name each cluster after its lowest stop_id (numeric where possible), which
        # stays stable across reruns unless that stop's membership changes.
        def key(s: str):
            return (0, int(s)) if s.isdigit() else (1, s)

        members_of: dict[int, list[str]] = {}
        for s, lab in zip(ids, labels, strict=True):
            members_of.setdefault(lab, []).append(s)
        cluster_id = {lab: min(m, key=key) for lab, m in members_of.items()}

        conn.execute(
            """
            DROP TABLE IF EXISTS transit.platform_cluster CASCADE;
            CREATE TABLE transit.platform_cluster (stop_id text PRIMARY KEY, cluster_id text);
            """
        )
        with conn.cursor().copy("COPY transit.platform_cluster FROM STDIN") as cp:
            for s, lab in zip(ids, labels, strict=True):
                cp.write_row((s, cluster_id[lab]))
    sizes = np.bincount([len(m) for m in members_of.values()])
    print(
        f"{len(ids)} platforms -> {len(members_of)} merged stops "
        f"(by size: {dict((i, int(n)) for i, n in enumerate(sizes) if n)})"
    )
