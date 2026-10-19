# Single entry point for the pipeline. Recipes are thin: the work happens in
# `transit <cmd>` inside the pipeline container, so host tool versions don't matter.
#
# Make can't see inside PostGIS, so each DB stage touches a stamp file in
# data/build/.stamps/. A stamp depends on its stage's SQL, on config/, and on the
# previous stamp: editing one SQL file reruns that stage and everything after it.
#
#   download -> load -> staging -> network -> stops -> generators -> catchments
#            -> export (tiles, stats, per-stop files)

COMPOSE := docker compose
RUN     := $(COMPOSE) run --rm pipeline uv run --project pipeline transit
STAMPS  := data/build/.stamps
CONFIG  := $(wildcard config/*)
SQL      = $(wildcard pipeline/sql/$(1)/*.sql)
PY      := $(wildcard pipeline/src/transit/*.py)

.PHONY: all db-up db-down db-reset psql image download init load staging network stops \
        generators catchments export tiles stats basemap test lint site

all: export

db-up:
	$(COMPOSE) up -d --wait db

db-down:
	$(COMPOSE) down

db-reset:  ## drop the database volume and all stamps
	$(COMPOSE) down -v
	rm -rf $(STAMPS)

psql: db-up
	$(COMPOSE) exec db psql -U $${PGUSER:-transit} -d $${PGDATABASE:-transit}

image:
	$(COMPOSE) build

download:
	$(RUN) download

init:       $(STAMPS)/init
load:       $(STAMPS)/load
staging:    $(STAMPS)/staging
network:    $(STAMPS)/network
stops:      $(STAMPS)/stops
generators: $(STAMPS)/generators
catchments: $(STAMPS)/catchments

$(STAMPS)/init: $(call SQL,00_init) | db-up
	$(RUN) sql 00_init
	@mkdir -p $(@D) && touch $@

# Reloading takes a few minutes and is only needed when downloads change.
$(STAMPS)/load: $(STAMPS)/init config/sources.toml config/road_classes.csv config/poi_categories.csv
	$(RUN) load
	@touch $@

$(STAMPS)/staging: $(STAMPS)/load $(call SQL,10_staging) $(CONFIG)
	$(RUN) sql 10_staging
	@touch $@

$(STAMPS)/network: $(STAMPS)/staging $(call SQL,20_network) $(CONFIG)
	$(RUN) sql 20_network
	@touch $@

# Stop clustering runs in Python (complete linkage), then the SQL computes frequencies
# and snaps platforms onto the network.
$(STAMPS)/stops: $(STAMPS)/network $(call SQL,30_stops) $(CONFIG) pipeline/src/transit/stops.py
	$(RUN) cluster
	$(RUN) sql 30_stops
	@touch $@

$(STAMPS)/generators: $(STAMPS)/stops $(call SQL,40_generators) $(CONFIG)
	$(RUN) sql 40_generators
	@touch $@

# Walk times from every stop (pgRouting, in parallel), then banded sums in SQL.
$(STAMPS)/catchments: $(STAMPS)/generators $(call SQL,50_catchments) $(CONFIG) pipeline/src/transit/reach.py
	$(RUN) reach
	$(RUN) sql 50_catchments
	@touch $@

# Products. Cheap relative to the analysis, so they always rerun.
export: $(STAMPS)/catchments
	$(RUN) sql 60_export
	$(RUN) export

basemap: $(STAMPS)/staging
	$(RUN) basemap

test:
	$(COMPOSE) run --rm pipeline uv run --project pipeline pytest pipeline/tests

lint:
	$(COMPOSE) run --rm --no-deps pipeline uv run --project pipeline ruff check pipeline
	$(COMPOSE) run --rm --no-deps pipeline uv run --project pipeline ruff format --check pipeline

site:
	cd site && npm run dev
