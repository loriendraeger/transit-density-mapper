"""Share of trips by destination purpose, from the 2022 NHTS trip file -> gen.purpose_shares.

Trip-generation practice: a destination's pull is the share of trips made for its
purpose (shopping, meals, school...). The NHTS asks every trip's purpose at the
destination (WHYTO); config/trip_purposes.csv maps those codes to the groups that
config/destination_groups.csv uses for POI categories. Purposes with no group (home,
work, visiting friends, changing mode...) are left out: homes and jobs are their own
score terms. Shares are weighted (WTTRDFIN) and sum to 1 over the groups.
40_generators/30_pois.sql then scales each group's POI weights to its share.
"""

import csv
from collections import defaultdict

import psycopg

from . import config

# pipeline.toml [generators] purpose_trips -> which trips count.
FILTERS = {
    "all": lambda r: True,
    "urban": lambda r: r["URBAN"] == "01",
    "transit": lambda r: r["TRIPMODE"] == "03",
}


def purposes() -> None:
    which = config.pipeline()["generators"]["purpose_trips"]
    keep = FILTERS[which]
    with open(config.CONFIG / "trip_purposes.csv", newline="") as f:
        group_of = {r["whyto"]: r["group"] for r in csv.DictReader(f) if r["group"]}
    weight: dict[str, float] = defaultdict(float)
    trips: dict[str, int] = defaultdict(int)
    path = config.REPO / config.sources()["nhts"]["local_path"]
    with open(path, newline="") as f:
        for r in csv.DictReader(f):
            group = group_of.get(r["WHYTO"])
            if group and keep(r):
                weight[group] += float(r["WTTRDFIN"])
                trips[group] += 1
    total = sum(weight.values())
    with psycopg.connect("") as conn:
        conn.execute("DROP TABLE IF EXISTS gen.purpose_shares CASCADE")
        conn.execute(
            "CREATE TABLE gen.purpose_shares (grp text PRIMARY KEY, share float8, trips int)"
        )
        with conn.cursor().copy("COPY gen.purpose_shares FROM STDIN") as cp:
            for g in sorted(weight):
                cp.write_row([g, weight[g] / total, trips[g]])
    print(f"purpose shares ({which} trips, {sum(trips.values())} to a destination):")
    for g in sorted(weight, key=lambda g: -weight[g]):
        print(f"  {g:10} {100 * weight[g] / total:5.1f} %  ({trips[g]} trips)")
