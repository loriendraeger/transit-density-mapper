#!/bin/sh
# Config slices for the pipeline steps, written to data/build/deps/:
#   toml.<section>   each pipeline.toml section (with its subtables, e.g. tiles.files.*)
#   poi_keys         the OSM keys that mark a destination (all the loader reads of
#                    poi_categories.csv)
#   road_walkable    road class + walkable (all the loader reads of road_classes.csv)
# Steps list these as inputs instead of whole config files, and stage.sh hashes their
# contents: changing a weight in poi_categories.csv doesn't touch poi_keys, so OSM isn't
# reloaded; changing [catchments] doesn't change toml.walk, so the network isn't rebuilt.
# Plain sh/awk so it runs on the host when make starts.
set -e
cd "$(dirname "$0")/.."
out=data/build/deps
mkdir -p "$out"

put() {  # put <name>: stdin -> $out/<name>
    cat > "$out/$1"
}

for s in study_area analysis stops frequency walk generators catchments tiles ridership; do
    awk -v s="$s" '
        /^\[/ { name = $0; gsub(/^\[|\]$/, "", name); f = (name == s || index(name, s ".") == 1); next }
        f
    ' config/pipeline.toml | put "toml.$s"
done
tail -n +2 config/poi_categories.csv | cut -d, -f1 | sort -u | put poi_keys
tail -n +2 config/road_classes.csv | cut -d, -f1,2 | sort | put road_walkable
