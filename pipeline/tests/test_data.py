"""Data validation against the built database (light; run with `make test`)."""

import pytest

from .conftest import scalar


def cluster_of(db, stop_id: str) -> str:
    return scalar(db, "SELECT cluster_id FROM transit.platform_cluster WHERE stop_id = %s", stop_id)


def test_every_used_stop_in_exactly_one_cluster(db):
    used = scalar(
        db,
        "SELECT count(DISTINCT s.stop_id) FROM staging.stops s "
        "JOIN staging.stop_times t USING (stop_id) WHERE coalesce(s.location_type, 0) = 0",
    )
    assert scalar(db, "SELECT count(*) FROM transit.platform_cluster") == used
    assert scalar(db, "SELECT count(DISTINCT stop_id) FROM transit.platform_cluster") == used


@pytest.mark.parametrize(
    "stops",
    [
        # E Washington & North: local and BRT stops at one intersection (owner's example).
        ["185", "183", "2859", "2860"],
        # W Johnson between East Campus Mall and Lake St: BRT and local interline.
        ["2843", "2866"],
    ],
)
def test_known_merges(db, stops):
    assert len({cluster_of(db, s) for s in stops}) == 1


def test_brt_platforms_merge_with_their_station(db):
    split = scalar(
        db,
        """
        SELECT count(*) FROM (
            SELECT s.parent_station FROM staging.stops s
            JOIN transit.platform_cluster pc USING (stop_id)
            WHERE s.parent_station IS NOT NULL
            GROUP BY s.parent_station HAVING count(DISTINCT pc.cluster_id) > 1) x
        """,
    )
    assert split == 0


def test_platforms_snap_close_to_network(db):
    assert scalar(db, "SELECT max(snap_dist) FROM net.platform_vertex") < 50


def test_population_sums_to_block_totals(db):
    """Placed population = the blocks' current estimates; growth since 2020 is modest."""
    placed = scalar(db, "SELECT sum(pop) FROM gen.population")
    blocks = scalar(db, "SELECT sum(pop) FROM gen.block_pop")
    pop2020 = scalar(db, "SELECT sum(pop2020) FROM gen.block_pop")
    assert 1.0 <= blocks / pop2020 < 1.15
    assert placed == pytest.approx(blocks, rel=1e-6)


def test_estimated_units_near_census_outside_madison(db):
    """Estimated dwelling units outside Madison land near the 2020 census count."""
    est = scalar(
        db,
        "SELECT sum(u.units) FROM gen.parcel_units u JOIN staging.parcels p USING (id) "
        "WHERE p.source = 'sco'",
    )
    assert 60_000 < est < 110_000


@pytest.mark.parametrize("stop_id", ["2843", "183"])
def test_brt_peak_frequency_plausible(db, stop_id):
    """Route A (BRT) runs about every 15 min on weekday peaks, counted per direction:
    W Johnson & East Campus is eastbound only; E Washington & North has both directions,
    which must not add up."""
    tph = scalar(
        db,
        "SELECT trips_per_hour FROM transit.period_freq "
        "WHERE cluster_id = %s AND route_id = 'A' AND period = 'peak'",
        cluster_of(db, stop_id),
    )
    assert 3.5 <= tph <= 8


def test_ten_minute_walkshed_plausible(db):
    """A 10-minute walk at 1.3 m/s is 780 m; on a street grid with crossing waits the
    reachable area is well under the 1.9 km2 circle, but not tiny."""
    km2 = scalar(
        db,
        """
        SELECT ST_Area(ST_ConvexHull(ST_Collect(v.geom))) / 1e6
        FROM catch.reach r JOIN net.vertices v ON v.id = r.vertex
        WHERE r.cluster_id = %s AND r.t <= 600
        """,
        cluster_of(db, "185"),
    )
    assert 0.5 < km2 < 1.9


def test_arterial_crossings_need_a_crossing(db):
    """No crossing connector exists without signal or marked-crosswalk evidence."""
    assert (
        scalar(db, "SELECT count(*) FROM net.base_edges WHERE kind = 'cross' AND control < 2") == 0
    )


def test_ridership_mostly_matched(db):
    """Most 2024 boardings land on a current platform (the rest: closed or moved stops)."""
    share = scalar(
        db,
        "SELECT sum(boardings) FILTER (WHERE stop_id IS NOT NULL) / sum(boardings) "
        "FROM valid.ridership",
    )
    assert share > 0.9


def test_fit_is_usable(db):
    """The fitted settings fall inside the site's slider ranges (largest weight at the
    top), and the cross-validated fit is positive but not better than in-sample."""
    p = dict(db.execute("SELECT key, value FROM valid.fit_params").fetchall())
    assert 5 <= p["walk_min"] <= 20 and 1 <= p["half_life"] <= 20
    assert all(0 <= p[k] <= 5 for k in ("w_pop", "w_jobs", "w_dest"))
    assert max(p["w_pop"], p["w_jobs"], p["w_dest"]) == 5
    assert 0 < p["cv_r2"] <= p["r2"] < 1


def test_potential_rates_plausible(db):
    """Trip ends per person a day are in the NHTS's usual range (urban Americans make
    about 3.5 trips, so 7 ends), and destination points are balanced to residents: the
    study area's destinations draw destination ends per person x residents."""
    r = dict(db.execute("SELECT key, value FROM gen.trip_rates").fetchall())
    assert 1.5 < r["home_per_person"] < 2.5
    assert 0.8 < r["work_per_worker"] < 1.5
    assert 1.2 < r["dest_per_person"] < 2.5
    p = dict(db.execute("SELECT key, value FROM valid.fit_params").fetchall())
    tot = dict(
        db.execute(
            "SELECT kind, sum(value) FROM (SELECT kind, gen_id, min(value) AS value "
            "FROM gen.points GROUP BY 1, 2) g GROUP BY 1"
        ).fetchall()
    )
    dest_ends = p["pot_dest_rate"] * (tot["poi"] + p["shop_jobs_weight"] * tot["shopjobs"])
    assert dest_ends == pytest.approx(r["dest_per_person"] * tot["pop"], rel=1e-9)


def test_school_trip_ends_follow_enrollment(db):
    """Every school's trip ends are counted once in full (its main points add up to
    enrollment x rate), and UW-Madison's spread over many campus buildings."""
    worst = scalar(
        db,
        """
        SELECT max(abs(p.v - s.trip_ends) / s.trip_ends)
        FROM gen.schools s
        JOIN (SELECT school_id, sum(value) AS v FROM gen.school_points WHERE main
              GROUP BY 1) p ON p.school_id = s.id
        """,
    )
    assert worst < 1e-9
    assert scalar(db, "SELECT count(*) FROM gen.schools WHERE id = 'ipeds240444'") == 1
    buildings = scalar(
        db, "SELECT count(*) FROM gen.campus_buildings WHERE school_id = 'ipeds240444'"
    )
    assert buildings > 50


def test_destination_totals_follow_trip_shares(db):
    """Each destination group's total weight matches its share of trips (NHTS)."""
    worst = scalar(
        db,
        """
        WITH g AS (
            SELECT dg.grp, sum(p.weight) / (SELECT sum(weight) FROM gen.pois) AS share
            FROM gen.pois p JOIN gen.dest_groups dg USING (category) GROUP BY dg.grp
        )
        SELECT max(abs(g.share - s.share)) FROM g JOIN gen.purpose_shares s USING (grp)
        """,
    )
    assert worst < 1e-6


def test_overlap_added_within_full(db):
    """What a stop adds over its neighbors is never more than its full catchment, and
    corridors overlap: the median stop adds well under half."""
    over = scalar(db, "SELECT count(*) FROM catch.marginal WHERE added > full_value + 1e-9")
    assert over == 0
    median = scalar(
        db,
        "SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY added / full_value) "
        "FROM catch.marginal WHERE measure = 'pop' AND full_value > 0",
    )
    assert 0 < median < 0.5


def test_transit_access_plausible(db):
    """From E Washington & North (BRT), tens of thousands of jobs are reachable within
    30 minutes by transit, more at the planned-trip percentile than at the median, and
    many residents can get there."""
    cid = cluster_of(db, "183")
    jobs = {
        p: scalar(
            db,
            "SELECT sum(value) FROM catch.access_bands "
            "WHERE cluster_id = %s AND pct = %s AND measure = 'jobs' AND band < 15",
            cid,
            p,
        )
        for p in (10, 50)
    }
    assert 30_000 < jobs[10] < 300_000
    assert jobs[10] >= jobs[50]
    homes = scalar(
        db,
        "SELECT sum(value) FROM catch.access_rev_bands WHERE cluster_id = %s AND pct = 10 "
        "AND band < 15",
        cid,
    )
    assert homes > 30_000
