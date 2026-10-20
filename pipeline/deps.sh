#!/bin/sh
# Content stamps for the Makefile, written to data/build/deps/:
#   toml.<section>   each pipeline.toml section (with its subtables, e.g. tiles.files.*)
#   poi_keys         the OSM keys that mark a destination (all the loader reads of
#                    poi_categories.csv)
#   road_walkable    road class + walkable (all the loader reads of road_classes.csv)
# A stamp is rewritten only when its content changes, so its timestamp says "this input
# changed". Rules depend on these instead of on whole config files: changing a weight in
# poi_categories.csv no longer reloads OSM, and changing [catchments] doesn't rebuild
# the network. Plain sh/awk so it runs on the host at Makefile parse time.
set -e
cd "$(dirname "$0")/.."
out=data/build/deps
mkdir -p "$out"

put() {  # put <name>: stdin -> $out/<name>, only if different
    tmp="$out/$1.tmp"
    cat > "$tmp"
    if cmp -s "$tmp" "$out/$1"; then rm "$tmp"; else mv "$tmp" "$out/$1"; fi
}

for s in study_area analysis stops frequency walk generators catchments tiles; do
    awk -v s="$s" '
        /^\[/ { name = $0; gsub(/^\[|\]$/, "", name); f = (name == s || index(name, s ".") == 1); next }
        f
    ' config/pipeline.toml | put "toml.$s"
done
tail -n +2 config/poi_categories.csv | cut -d, -f1 | sort -u | put poi_keys
tail -n +2 config/road_classes.csv | cut -d, -f1,2 | sort | put road_walkable
