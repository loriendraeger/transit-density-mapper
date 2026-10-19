"""Run pipeline/sql/<stage>/*.sql in filename order through psql.

Values from config/pipeline.toml are passed as psql variables, so SQL writes :crs or
:'name' instead of hardcoding them.

Timing: each file's wall time is printed, plus every statement that took at least
SLOW_S. The full per-statement log goes to data/build/timings/<stage>.tsv.
"""

import os
import re
import subprocess
import time

from . import config

TIMINGS = config.BUILD / "timings"
SLOW_S = 1.0
_TIME = re.compile(r"^Time: ([0-9.]+) ms")


def _statement_times(output: str) -> list[tuple[str, float]]:
    """Pair each echoed statement (psql -e) with the `Time:` line \\timing prints after it.
    The label is the statement's first line, which is enough to find it in the file."""
    out: list[tuple[str, float]] = []
    label = ""
    for line in output.splitlines():
        m = _TIME.match(line)
        if m:
            out.append((label, float(m.group(1)) / 1000))
            label = ""
        elif not label and line.strip() and not line.startswith("--"):
            label = " ".join(line.split())[:100]
    return out


def stages() -> list[str]:
    return sorted(p.name for p in config.SQL_DIR.iterdir() if p.is_dir())


def run_stage(stage: str, overrides: dict[str, str] | None = None) -> None:
    """Run a stage. `overrides` replace pipeline.toml values for this run only, for
    experiments such as comparing settings."""
    files = sorted((config.SQL_DIR / stage).glob("*.sql"))
    if not files:
        raise FileNotFoundError(f"no SQL files in {config.SQL_DIR / stage}")
    values = config.psql_vars()
    for key in overrides or {}:
        if key not in values:
            raise SystemExit(f"--set {key}: not a pipeline.toml key")
    values |= overrides or {}
    variables = [arg for k, v in values.items() for arg in ("-v", f"{k}={v}")]
    TIMINGS.mkdir(parents=True, exist_ok=True)
    log = ["file\tseconds\tstatement"]
    stage_start = time.monotonic()
    for f in files:
        print(f"== {stage}/{f.name}", end="", flush=True)
        start = time.monotonic()
        # Run from the repo root so \copy can use repo-relative paths like config/x.csv.
        # -e echoes each statement and \timing prints its duration; both go to stdout,
        # which we capture. Errors still go to stderr (the terminal).
        result = subprocess.run(
            [
                "psql",
                "-X",
                "-q",
                "-e",
                "-v",
                "ON_ERROR_STOP=1",
                *variables,
                "-c",
                "\\timing on",
                "-f",
                str(f),
            ],
            cwd=config.REPO,
            # Hide the NOTICEs that every idempotent DROP ... IF EXISTS prints.
            env={**os.environ, "PGOPTIONS": "-c client_min_messages=warning"},
            stdout=subprocess.PIPE,
            text=True,
        )
        print(f"  {time.monotonic() - start:6.1f} s", flush=True)
        for label, secs in _statement_times(result.stdout):
            log.append(f"{f.name}\t{secs:.2f}\t{label}")
            if secs >= SLOW_S:
                print(f"     {secs:7.1f} s  {label}", flush=True)
        if result.returncode != 0:
            # psql already printed the error with file and line; no traceback needed.
            raise SystemExit(f"stage {stage} failed in {f.name}")
    (TIMINGS / f"{stage}.tsv").write_text("\n".join(log) + "\n")
    print(
        f"== {stage}: {time.monotonic() - stage_start:.1f} s "
        f"(per-statement log: {(TIMINGS / f'{stage}.tsv').relative_to(config.REPO)})",
        flush=True,
    )
