# Single entry point for the pipeline. Recipes are thin: the work happens in
# `transit <cmd>` inside the pipeline container, so host tool versions don't matter.
#
#   download -> load -> staging -> network -> stops -> generators ----> catchments
#                                                \-> reach ----------/      |
#   exports: network.pmtiles (network), generators.pmtiles (generators),
#            stops.json (catchments), catchments.bin (reach)
#
# Make only orders the steps; whether a step runs is decided by content hashes, not
# file timestamps. Each step goes through pipeline/stage.sh with its inputs: its SQL and
# Python, the config it reads (whole files, or slices from pipeline/deps.sh: one per
# pipeline.toml section, plus the config columns the loader reads), and the stamps of
# the steps before it. The step runs only if the SHA-256 over those contents differs
# from the one stored in data/build/.stamps/<step> when it last succeeded. So changing a
# destination weight reruns generators -> catchments -> stops.json and
# generators.pmtiles (~20 s); touching or re-saving a file without changing it reruns
# nothing.

COMPOSE := docker compose
TOOLS   := $(COMPOSE) --profile tools
# Every step runs in one long-lived pipeline container (started by tools-up): `exec`
# into it is near-instant, where a fresh `run --rm` container took ~3 s per step.
EXEC    := $(COMPOSE) exec -T pipeline uv run --project pipeline
RUN     := $(EXEC) transit
STAGE   := @sh pipeline/stage.sh
S       := data/build/.stamps
D       := data/build/deps
OUT     := site/public/data
SQL      = $(wildcard pipeline/sql/$(1)/*.sql)
PY       = pipeline/src/transit/$(1).py
COMMON  := $(call PY,config) $(call PY,sqlrun)

# Refresh the config slices every time make runs (on the host; cheap).
_ := $(shell sh pipeline/deps.sh)

.PHONY: all db-up tools-up db-down db-reset psql image download init load staging network \
        stops generators reach catchments views-network views-generators export \
        network-tiles generators-tiles stops-json catchments-bin basemap test lint site

all: export

db-up:
	$(COMPOSE) up -d --wait db

tools-up:
	@$(TOOLS) up -d --wait pipeline

db-down:
	$(TOOLS) down

db-reset:  ## drop the database volume and all stamps
	$(TOOLS) down -v
	rm -rf $(S)

psql: db-up
	$(COMPOSE) exec db psql -U $${PGUSER:-transit} -d $${PGDATABASE:-transit}

image:
	$(TOOLS) build

download: | tools-up
	$(RUN) download

init: | tools-up
	$(STAGE) init '$(RUN) sql 00_init' $(call SQL,00_init) $(COMMON)

# Reloading takes about a minute and is only needed when downloads change.
load: init | tools-up
	$(STAGE) load '$(RUN) load' $(S)/init config/sources.toml $(D)/poi_keys \
	    $(D)/road_walkable $(D)/toml.study_area $(call PY,load) $(call PY,osm)

staging: load | tools-up
	$(STAGE) staging '$(RUN) sql 10_staging' $(S)/load $(call SQL,10_staging) \
	    config/road_classes.csv $(D)/toml.analysis $(COMMON)

network: staging | tools-up
	$(STAGE) network '$(RUN) sql 20_network' $(S)/staging $(call SQL,20_network) \
	    $(D)/toml.walk $(COMMON)

# Stop clustering runs in Python (complete linkage), then the SQL computes frequencies
# and snaps platforms onto the network.
stops: network | tools-up
	$(STAGE) stops '$(RUN) cluster && $(RUN) sql 30_stops' $(S)/network \
	    $(call SQL,30_stops) $(call PY,stops) config/stop_merge_overrides.csv \
	    $(D)/toml.stops $(D)/toml.frequency $(D)/toml.walk $(COMMON)

generators: stops | tools-up
	$(STAGE) generators '$(RUN) sql 40_generators' $(S)/stops $(call SQL,40_generators) \
	    config/poi_categories.csv $(D)/toml.generators $(D)/toml.walk \
	    $(D)/toml.study_area $(COMMON)

# Walk times from every stop (pgRouting, in parallel), then per-edge times.
reach: stops | tools-up
	$(STAGE) reach '$(RUN) reach && $(RUN) sql 50_reach' $(S)/stops \
	    $(call SQL,50_reach) $(call PY,reach) $(D)/toml.walk $(COMMON)

# Walk time to every generator and the banded totals per stop.
catchments: reach generators | tools-up
	$(STAGE) catchments '$(RUN) sql 55_catchments' $(S)/reach $(S)/generators \
	    $(call SQL,55_catchments) $(D)/toml.walk $(COMMON)

# Export views, one SQL stage per tile file (dropping tables upstream drops views).
views-network: network | tools-up
	$(STAGE) views-network '$(RUN) sql 60_export_network' $(S)/network \
	    $(call SQL,60_export_network) $(COMMON)

views-generators: generators | tools-up
	$(STAGE) views-generators '$(RUN) sql 61_export_generators' $(S)/generators \
	    $(call SQL,61_export_generators) $(COMMON)

# Products: each file rebuilds only when its own inputs change (or it's missing).
export: network-tiles generators-tiles stops-json catchments-bin

network-tiles: views-network | tools-up
	$(STAGE) network-tiles '$(RUN) tiles network' $(S)/views-network $(D)/toml.tiles \
	    $(call PY,export) out:$(OUT)/network.pmtiles

generators-tiles: views-generators | tools-up
	$(STAGE) generators-tiles '$(RUN) tiles generators' $(S)/views-generators \
	    $(D)/toml.tiles $(call PY,export) out:$(OUT)/generators.pmtiles

stops-json: catchments | tools-up
	$(STAGE) stops-json '$(RUN) stops-json' $(S)/catchments config/sources.toml \
	    $(D)/toml.frequency $(D)/toml.walk $(D)/toml.stops $(call PY,export) \
	    out:$(OUT)/stops.json

catchments-bin: reach | tools-up
	$(STAGE) catchments-bin '$(RUN) catchments' $(S)/reach $(D)/toml.catchments \
	    $(D)/toml.walk $(D)/toml.analysis $(call PY,export) out:$(OUT)/catchments.bin

basemap: | tools-up
	$(RUN) basemap

test: | tools-up
	$(EXEC) pytest pipeline/tests

lint: | tools-up
	$(EXEC) ruff check pipeline
	$(EXEC) ruff format --check pipeline

site:
	cd site && npm run dev
