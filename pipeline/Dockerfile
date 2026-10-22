# Pipeline tools: GDAL/OGR, psql, osmium, tippecanoe, pmtiles, uv (Python 3.12), and a
# Java 21 runtime for R5 (transit routing via r5py).
# Pinned so the pipeline gives the same results regardless of what's on the host.

# --- tippecanoe has no binary releases; build it in a throwaway stage -------------
FROM ubuntu:24.04 AS tippecanoe
ARG TIPPECANOE_VERSION=2.79.0
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential ca-certificates curl libsqlite3-dev zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://github.com/felt/tippecanoe/archive/refs/tags/${TIPPECANOE_VERSION}.tar.gz | tar xz \
    && make -C tippecanoe-${TIPPECANOE_VERSION} -j"$(nproc)" \
    && make -C tippecanoe-${TIPPECANOE_VERSION} install PREFIX=/opt/tippecanoe

FROM ghcr.io/astral-sh/uv:0.12.19 AS uv

# --- runtime ---------------------------------------------------------------------
FROM ghcr.io/osgeo/gdal:ubuntu-small-3.13.3
ARG PMTILES_VERSION=1.31.2
ARG TARGETARCH

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl make osmium-tool postgresql-client openjdk-21-jre-headless \
    && rm -rf /var/lib/apt/lists/*

COPY --from=tippecanoe /opt/tippecanoe/bin/ /usr/local/bin/
COPY --from=uv /uv /uvx /usr/local/bin/

RUN arch=$([ "$TARGETARCH" = "arm64" ] && echo arm64 || echo x86_64) \
    && curl -fsSL "https://github.com/protomaps/go-pmtiles/releases/download/v${PMTILES_VERSION}/go-pmtiles_${PMTILES_VERSION}_Linux_${arch}.tar.gz" \
       | tar xz -C /usr/local/bin pmtiles

# The repo is bind-mounted at /work. Keep the venv outside it so the host's
# (macOS) and the container's (Linux) environments don't collide.
# uv installs a managed Python 3.12 (the base image's system Python is newer).
ENV UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_PYTHON_INSTALL_DIR=/opt/python \
    UV_LINK_MODE=copy \
    PATH=/opt/venv/bin:$PATH
RUN uv python install 3.12
WORKDIR /work/pipeline
COPY pyproject.toml uv.lock* ./
RUN uv sync --no-install-project
WORKDIR /work
