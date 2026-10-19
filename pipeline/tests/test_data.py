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


def test_population_sums_to_census(db):
    placed = scalar(db, "SELECT sum(pop) FROM gen.population")
    census = scalar(db, "SELECT sum(pop) FROM staging.blocks")
    assert placed == pytest.approx(census, rel=1e-6)


def test_estimated_units_near_census_outside_madison(db):
    """Estimated dwelling units outside Madison land near the 2020 census count."""
    est = scalar(
        db,
        "SELECT sum(u.units) FROM gen.parcel_units u JOIN staging.parcels p USING (id) "
        "WHERE p.source = 'sco'",
    )
    assert 60_000 < est < 110_000


def test_brt_peak_frequency_plausible(db):
    """Route A (BRT) runs about every 15 min on weekday peaks; East Campus is eastbound only."""
    tph = scalar(
        db,
        "SELECT trips_per_hour FROM transit.period_freq "
        "WHERE cluster_id = %s AND route_id = 'A' AND period = 'peak'",
        cluster_of(db, "2843"),
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
