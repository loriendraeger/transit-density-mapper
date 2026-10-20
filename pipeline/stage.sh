#!/bin/sh
# Run a pipeline step only if its inputs' contents changed since it last succeeded.
#
#   stage.sh NAME COMMAND [INPUT...]
#
# INPUTs are files whose contents count (SQL, Python, config, content stamps from
# deps.sh, and the stamps of earlier steps); an INPUT written out:PATH is an output that
# must exist (a deleted output reruns the step) but isn't hashed.
#
# The step's fingerprint is a SHA-256 over every input's path and content hash. It's
# stored in data/build/.stamps/NAME when COMMAND succeeds. If the stored fingerprint
# matches and the outputs exist, the step is skipped. Since a step's stamp holds its
# fingerprint, a later step that lists it as an input reruns whenever this one ran
# with different inputs. File timestamps play no part: touching, re-saving or checking
# out a file without changing it reruns nothing.
set -e
name=$1
cmd=$2
shift 2
stamps=data/build/.stamps
mkdir -p "$stamps"

files=""
for f in "$@"; do
    case $f in
        out:*) ;;
        *)
            if [ ! -f "$f" ]; then
                echo "stage.sh: $name: input $f is missing" >&2
                exit 1
            fi
            files="$files $f"
            ;;
    esac
done
# shellcheck disable=SC2086  # word splitting of the file list is intended
fingerprint=$(shasum -a 256 $files | LC_ALL=C sort -k 2 | shasum -a 256 | cut -d' ' -f1)

fresh=1
[ -f "$stamps/$name" ] && [ "$(cat "$stamps/$name")" = "$fingerprint" ] || fresh=0
for f in "$@"; do
    case $f in
        out:*) [ -e "${f#out:}" ] || fresh=0 ;;
    esac
done
if [ "$fresh" = 1 ]; then
    echo "-- $name: up to date"
    exit 0
fi

echo "== $name"
sh -c "$cmd"
printf '%s\n' "$fingerprint" > "$stamps/$name"
