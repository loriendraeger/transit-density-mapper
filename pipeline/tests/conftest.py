import psycopg
import pytest


@pytest.fixture(scope="session")
def db():
    """The pipeline database (PG* env vars). Tests read the analysis tables, so run them
    after `make` (or at least `make fit`)."""
    with psycopg.connect("") as conn:
        yield conn


def scalar(db, sql: str, *params):
    return db.execute(sql, params).fetchone()[0]
