# PostGIS + pgRouting. The official pgrouting/pgrouting images are amd64-only, so extend
# the multi-arch PostGIS build (same base as ../public-private-shore) with the
# pgRouting package from the PostgreSQL apt repo the image already uses.
FROM imresamu/postgis:17-3.5
RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-17-pgrouting \
    && rm -rf /var/lib/apt/lists/*
