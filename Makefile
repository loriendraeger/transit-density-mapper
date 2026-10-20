# Single entry point for the pipeline. Recipes are thin: the work happens in
# `transit <cmd>` inside the pipeline container, so host tool versions don't matter.
#
#   download -> load -> staging -> network -> stops -> generators ----> catchments
#                                                \-> reach ----------/      |
#   exports: network.pmtiles (network), generators.pmtiles (generators),
#            stops.json (catchments), catchments.bin (reach)
#
# Make can't see inside PostGIS, so each DB stage touches a stamp file in
# data/build/.stamps/. A stamp depends on its stage's SQL and Python, the previous
# stamps, and only the config it reads: the content stamps in data/build/deps/ (one per
# pipeline.toml section, and the config columns the loader reads; see pipeline/deps.sh)
# or whole config files. So changing a destination weight reruns generators ->
# catchments -> stops.json and generators.pmtiles (~20 s), not everything.

COMPOSE := docker compose
TOOLS   := $(COMPOSE) --profile tools
# Every step runs in one long-lived pipeline container (started by tools-up): `exec`
# into it is near-instant, where a fresh `run --rm` container took ~3 s per step.
EXEC    := $(COMPOSE) exec -T pipeline uv run --project pipeline
RUN     := $(EXEC) transit
STAMPS  := data/build/.stamps
D       := data/build/deps
OUT     := site/public/data
SQL      = $(wildcard pipeline/sql/$(1)/*.sql)
PY       = pipeline/src/transit/$(1).py
COMMON  := $(call PY,config) $(call PY,sqlrun)

# Refresh the content stamps every time make runs (parse time, on the host; cheap).
_ := $(shell sh pipeline/deps.sh)

.PHONY: all db-up tools-up db-down db-reset psql image download init load staging network \
        stops generators reach catchments export basemap test lint site

all: export

db-up:
	$(COMPOSE) up -d --wait db

tools-up:
	@$(TOOLS) up -d --wait pipeline

db-down:
	$(TOOLS) down

db-reset:  ## drop the database volume and all stamps
	$(TOOLS) down -v
	rm -rf $(STAMPS)

psql: db-up
	$(COMPOSE) exec db psql -U $${PGUSER:-transit} -d $${PGDATABASE:-transit}

image:
	$(TOOLS) build

download: | tools-up
	$(RUN) download

init:       $(STAMPS)/init
load:       $(STAMPS)/load
staging:    $(STAMPS)/staging
network:    $(STAMPS)/network
stops:      $(STAMPS)/stops
generators: $(STAMPS)/generators
reach:      $(STAMPS)/reach
catchments: $(STAMPS)/catchments

$(STAMPS)/init: $(call SQL,00_init) | tools-up
	$(RUN) sql 00_init
	@mkdir -p $(@D) && touch $@

# Reloading takes about a minute and is only needed when downloads change.
$(STAMPS)/load: $(STAMPS)/init config/sources.toml $(D)/poi_keys $(D)/road_walkable \
                $(D)/toml.study_area $(call PY,load) $(call PY,osm) | tools-up
	$(RUN) load
	@touch $@

$(STAMPS)/staging: $(STAMPS)/load $(call SQL,10_staging) config/road_classes.csv \
                   $(D)/toml.analysis $(COMMON) | tools-up
	$(RUN) sql 10_staging
	@touch $@

$(STAMPS)/network: $(STAMPS)/staging $(call SQL,20_network) $(D)/toml.walk | tools-up
	$(RUN) sql 20_network
	@touch $@

# Stop clustering runs in Python (complete linkage), then the SQL computes frequencies
# and snaps platforms onto the network.
$(STAMPS)/stops: $(STAMPS)/network $(call SQL,30_stops) $(call PY,stops) \
                 config/stop_merge_overrides.csv $(D)/toml.stops $(D)/toml.frequency \
                 $(D)/toml.walk | tools-up
	$(RUN) cluster
	$(RUN) sql 30_stops
	@touch $@

$(STAMPS)/generators: $(STAMPS)/stops $(call SQL,40_generators) config/poi_categories.csv \
                      $(D)/toml.generators $(D)/toml.walk $(D)/toml.study_area | tools-up
	$(RUN) sql 40_generators
	@touch $@

# Walk times from every stop (pgRouting, in parallel), then per-edge times.
$(STAMPS)/reach: $(STAMPS)/stops $(call SQL,50_reach) $(call PY,reach) $(D)/toml.walk | tools-up
	$(RUN) reach
	$(RUN) sql 50_reach
	@touch $@

# Walk time to every generator and the banded totals per stop.
$(STAMPS)/catchments: $(STAMPS)/reach $(STAMPS)/generators $(call SQL,55_catchments) \
                      $(D)/toml.walk | tools-up
	$(RUN) sql 55_catchments
	@touch $@

# Export views, one SQL stage per tile file (dropping tables upstream drops views).
$(STAMPS)/views-network: $(STAMPS)/network $(call SQL,60_export_network) | tools-up
	$(RUN) sql 60_export_network
	@touch $@

$(STAMPS)/views-generators: $(STAMPS)/generators $(call SQL,61_export_generators) | tools-up
	$(RUN) sql 61_export_generators
	@touch $@

# Products: each file rebuilds only when its own inputs change.
export: $(OUT)/network.pmtiles $(OUT)/generators.pmtiles $(OUT)/stops.json $(OUT)/catchments.bin

$(OUT)/network.pmtiles: $(STAMPS)/views-network $(D)/toml.tiles $(call PY,export) | tools-up
	$(RUN) tiles network

$(OUT)/generators.pmtiles: $(STAMPS)/views-generators $(D)/toml.tiles $(call PY,export) | tools-up
	$(RUN) tiles generators

$(OUT)/stops.json: $(STAMPS)/catchments config/sources.toml $(D)/toml.frequency \
                   $(D)/toml.walk $(D)/toml.stops $(call PY,export) | tools-up
	$(RUN) stops-json

$(OUT)/catchments.bin: $(STAMPS)/reach $(D)/toml.catchments $(D)/toml.walk \
                       $(D)/toml.analysis $(call PY,export) | tools-up
	$(RUN) catchments

basemap: | tools-up
	$(RUN) basemap

test: | tools-up
	$(EXEC) pytest pipeline/tests

lint: | tools-up
	$(EXEC) ruff check pipeline
	$(EXEC) ruff format --check pipeline

site:
	cd site && npm run dev
