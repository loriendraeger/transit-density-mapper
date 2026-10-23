"""Share of trips by destination purpose, from the 2022 NHTS trip file -> gen.purpose_shares.

Trip-generation practice: a destination's pull is the share of trips made for its
purpose (shopping, meals, school...). The NHTS asks every trip's purpose at the
destination (WHYTO); config/trip_purposes.csv maps those codes to the groups that
config/destination_groups.csv uses for POI categories. Purposes with no group (home,
work, visiting friends, changing mode...) are left out: homes and jobs are their own
score terms. Shares are weighted (WTTRDFIN) and sum to 1 over the groups.
40_generators/30_pois.sql then scales each group's POI weights to its share.

The same file gives trip-end rates for the potential score (all modes; fit.py,
site/src/lib/scoring.ts): every trip has two ends, each at a place of some kind
(WHYFROM, WHYTO; trip_purposes.csv `trip_end`: home, work, destination, or blank when
the end can't be placed, e.g. changing mode). Ends per resident and day are weighted
trip ends (WTTRDFIN is annual, so / 365) over weighted persons (WTPERFIN, person file);
work ends are also given per worker (WORKER = 01), which the potential applies per job,
and school ends per K-12 and per college student (SCHOOL1 = 01; STUDE 01 = K-12, 02-05 =
college), which 40_generators/35_schools.sql applies to NCES enrollment.
-> gen.trip_rates (key, value).
"""

import csv
from collections import defaultdict

import psycopg

from . import config

# Trip-end rates count trips and persons in urban areas, like the shares' default.
URBAN = "01"

# NHTS person STUDE (enrolled in) -> school level, for school trip ends per student.
STUDENT_LEVEL = {"01": "k12", "02": "college", "03": "college", "04": "college", "05": "college"}

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
        rows = list(csv.DictReader(f))
    group_of = {r["whyto"]: r["group"] for r in rows if r["group"]}
    end_of = {r["whyto"]: r["trip_end"] for r in rows if r["trip_end"]}
    weight: dict[str, float] = defaultdict(float)
    trips: dict[str, int] = defaultdict(int)
    ends: dict[str, float] = defaultdict(float)  # weighted trip ends per day, urban
    path = config.REPO / config.sources()["nhts"]["local_path"]
    # Persons first: who's a worker or a student (by school level), weighted.
    persons = workers = 0.0
    student_of: dict[tuple[str, str], str] = {}
    students: dict[str, float] = defaultdict(float)
    with open(path.with_name("perv2pub.csv"), newline="") as f:
        for r in csv.DictReader(f):
            if r["URBAN"] != URBAN:
                continue
            w = float(r["WTPERFIN"])
            persons += w
            workers += w if r["WORKER"] == "01" else 0.0
            level = STUDENT_LEVEL.get(r["STUDE"]) if r["SCHOOL1"] == "01" else None
            if level:
                student_of[(r["HOUSEID"], r["PERSONID"])] = level
                students[level] += w
    school_ends: dict[str, float] = defaultdict(float)
    with open(path, newline="") as f:
        for r in csv.DictReader(f):
            group = group_of.get(r["WHYTO"])
            if group and keep(r):
                weight[group] += float(r["WTTRDFIN"])
                trips[group] += 1
            if r["URBAN"] == URBAN:
                for why in (r["WHYFROM"], r["WHYTO"]):
                    end = end_of.get(why, "unplaced")
                    ends[end] += float(r["WTTRDFIN"]) / 365
                    if end == "school":
                        level = student_of.get((r["HOUSEID"], r["PERSONID"]), "other")
                        school_ends[level] += float(r["WTTRDFIN"]) / 365
    total = sum(weight.values())
    rates = {
        "home_per_person": ends["home"] / persons,
        "work_per_person": ends["work"] / persons,
        "work_per_worker": ends["work"] / workers,
        "dest_per_person": ends["destination"] / persons,
        "school_per_person": ends["school"] / persons,
        "school_per_k12_student": school_ends["k12"] / students["k12"],
        "school_per_college_student": school_ends["college"] / students["college"],
        "unplaced_per_person": ends["unplaced"] / persons,
    }
    with psycopg.connect("") as conn:
        conn.execute("DROP TABLE IF EXISTS gen.purpose_shares CASCADE")
        conn.execute(
            "CREATE TABLE gen.purpose_shares (grp text PRIMARY KEY, share float8, trips int)"
        )
        with conn.cursor().copy("COPY gen.purpose_shares FROM STDIN") as cp:
            for g in sorted(weight):
                cp.write_row([g, weight[g] / total, trips[g]])
        conn.execute("DROP TABLE IF EXISTS gen.trip_rates CASCADE")
        conn.execute("CREATE TABLE gen.trip_rates (key text PRIMARY KEY, value float8)")
        with conn.cursor().copy("COPY gen.trip_rates FROM STDIN") as cp:
            for k, v in rates.items():
                cp.write_row([k, v])
    print(f"purpose shares ({which} trips, {sum(trips.values())} to a destination):")
    for g in sorted(weight, key=lambda g: -weight[g]):
        print(f"  {g:10} {100 * weight[g] / total:5.1f} %  ({trips[g]} trips)")
    print("trip ends per person and day (urban):")
    for k, v in rates.items():
        print(f"  {k:26} {v:.3f}")
