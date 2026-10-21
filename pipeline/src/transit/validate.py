"""Check the catchment score against observed boardings (valid.cluster_ridership).

The score is recomputed here at the site's default settings (site/src/lib/scoring.ts:
exponential decay, 8 min half-life, 10 min limit, weights 1:1:1, every destination
category 1), so the numbers match what the site shows. Three questions:

1. Does the score rank stops like boardings do? (Spearman rank correlation.)
2. How much does it add to frequency? Boardings depend heavily on how often the bus
   comes, so compare a frequency-only model with frequency + catchment.
3. Which stops get far more or fewer riders than the model expects? (Residuals.)

The model is the usual direct ridership model form: log boardings against log
frequency and log catchment totals, fit by least squares. Writes
data/build/validation/ridership.md and prints it.
"""

import math

import numpy as np
import psycopg
from psycopg.rows import dict_row
from scipy.stats import spearmanr

from . import config

OUT = config.BUILD / "validation" / "ridership.md"
# Site defaults (site/src/state/store.ts).
WALK_MIN = 10
HALF_LIFE_MIN = 8
# Boardings are weekday averages, so frequency is the weekday mix.
WEEKDAY_PERIODS = ("peak", "offpeak")


def band_weights(n_bands: int, band_min: float) -> np.ndarray:
    """Exponential decay at each band's middle, zero past the walk limit (bandWeights)."""
    return np.array(
        [
            0.5 ** ((i + 0.5) * band_min / HALF_LIFE_MIN)
            if (i + 1) * band_min <= WALK_MIN + 1e-9
            else 0.0
            for i in range(n_bands)
        ]
    )


def load() -> dict:
    p = config.pipeline()
    band_min = p["walk"]["band_min"]
    n_bands = math.ceil(p["walk"]["max_walk_min"] / band_min)
    bw = band_weights(n_bands, band_min)
    f = p["frequency"]
    period_w = {"peak": f["weight_peak"], "offpeak": f["weight_offpeak"]}
    with psycopg.connect("", row_factory=dict_row) as conn:
        # The stops the site has: those with a catchment.
        stops = conn.execute(
            "SELECT c.cluster_id AS id, c.name, r.boardings "
            "FROM transit.clusters c LEFT JOIN valid.cluster_ridership r USING (cluster_id) "
            "WHERE EXISTS (SELECT 1 FROM catch.reach x WHERE x.cluster_id = c.cluster_id) "
            "ORDER BY c.cluster_id"
        ).fetchall()
        idx = {s["id"]: i for i, s in enumerate(stops)}
        comp = {k: np.zeros(len(stops)) for k in ("pop", "jobs", "dest")}
        for r in conn.execute("SELECT cluster_id, band, measure, value FROM catch.bands"):
            i = idx.get(r["cluster_id"])
            if i is None or r["band"] > n_bands:
                continue
            k = r["measure"] if r["measure"] in ("pop", "jobs") else "dest"
            comp[k][i] += r["value"] * bw[r["band"] - 1]
        freq = np.zeros(len(stops))
        for r in conn.execute(
            "SELECT cluster_id, period, sum(trips_per_hour) AS tph FROM transit.period_freq "
            "WHERE period = ANY(%s) GROUP BY 1, 2",
            (list(WEEKDAY_PERIODS),),
        ):
            i = idx.get(r["cluster_id"])
            if i is not None:
                freq[i] += r["tph"] * period_w[r["period"]] / sum(period_w.values())
        match = conn.execute(
            "SELECT count(*) AS n, count(stop_id) AS matched, sum(boardings) AS total, "
            "sum(boardings) FILTER (WHERE stop_id IS NULL) AS unmatched, "
            "count(*) FILTER (WHERE matched_by = 'nearest') AS by_nearest "
            "FROM valid.ridership"
        ).fetchone()
        unmatched_top = conn.execute(
            "SELECT stop_name, round(boardings)::int AS boardings FROM valid.ridership "
            "WHERE stop_id IS NULL ORDER BY boardings DESC LIMIT 5"
        ).fetchall()
    norm = {k: 100 * v / max(v.max(), 1e-9) for k, v in comp.items()}
    score = (norm["pop"] + norm["jobs"] + norm["dest"]) / 3
    return {
        "stops": stops,
        "boardings": np.array(
            [s["boardings"] if s["boardings"] is not None else np.nan for s in stops]
        ),
        "comp": comp,
        "score": score,
        "freq": freq,
        "match": match,
        "unmatched_top": unmatched_top,
    }


def ols(y: np.ndarray, cols: dict[str, np.ndarray]) -> tuple[dict[str, float], float, np.ndarray]:
    """Least squares with an intercept: coefficients, R², residuals."""
    x = np.column_stack([np.ones_like(y), *cols.values()])
    beta, *_ = np.linalg.lstsq(x, y, rcond=None)
    resid = y - x @ beta
    r2 = 1 - (resid**2).sum() / ((y - y.mean()) ** 2).sum()
    return dict(zip(["intercept", *cols], beta, strict=True)), r2, resid


def report(d: dict) -> str:
    has = ~np.isnan(d["boardings"])
    b = d["boardings"][has]
    score, freq = d["score"][has], d["freq"][has]
    comp = {k: v[has] for k, v in d["comp"].items()}
    names = [f"{s['name']} ({s['id']})" for s, h in zip(d["stops"], has, strict=True) if h]
    m = d["match"]
    lines = [
        "# Catchment score vs. observed boardings",
        "",
        "Weekday boardings: Greater Madison MPO, February 2024 (farebox + AVL estimates).",
        f"Score at the site defaults: exponential decay, {HALF_LIFE_MIN} min half-life, "
        f"{WALK_MIN} min limit, weights 1:1:1. Frequency: weekday peak/off-peak mix, per "
        "direction.",
        "",
        "## Matching",
        "",
        f"- {m['matched']} of {m['n']} MPO stops matched to a current platform "
        f"({m['by_nearest']} by position); unmatched hold {m['unmatched']:.0f} of "
        f"{m['total']:.0f} boardings ({100 * m['unmatched'] / m['total']:.1f} %). Largest: "
        + ", ".join(f"{r['stop_name']} ({r['boardings']})" for r in d["unmatched_top"])
        + ".",
        f"- {has.sum()} of {len(has)} merged stops have a boardings figure; the other "
        f"{(~has).sum()} are new or moved since 2024 and are left out.",
        "",
        "## Rank correlation with boardings (Spearman ρ)",
        "",
        "| Measure | ρ |",
        "|---|---|",
    ]
    per_bus = b / np.maximum(freq, 0.1)
    rows = [
        ("Catchment score", score, b),
        ("Population (decay-weighted)", comp["pop"], b),
        ("Jobs (decay-weighted)", comp["jobs"], b),
        ("Destinations (decay-weighted)", comp["dest"], b),
        ("Frequency (trips/h per direction)", freq, b),
        ("Score × frequency", score * freq, b),
        ("Score vs. boardings per trip/h", score, per_bus),
    ]
    for label, x, y in rows:
        lines.append(f"| {label} | {spearmanr(x, y).statistic:.2f} |")

    # Direct ridership model on log scales (+1 so zeros stay finite).
    y = np.log1p(b)
    lf = np.log1p(freq)
    base, r2_base, _ = ols(y, {"log freq": lf})
    full_cols = {
        "log freq": lf,
        "log pop": np.log1p(comp["pop"]),
        "log jobs": np.log1p(comp["jobs"]),
        "log dest": np.log1p(comp["dest"]),
    }
    full, r2_full, resid = ols(y, full_cols)
    _, r2_score, _ = ols(y, {"log freq": lf, "log score": np.log1p(score)})
    lines += [
        "",
        "## Direct ridership model: log(1 + boardings)",
        "",
        "| Model | R² |",
        "|---|---|",
        f"| Frequency only | {r2_base:.2f} |",
        f"| Frequency + score | {r2_score:.2f} |",
        f"| Frequency + population + jobs + destinations | {r2_full:.2f} |",
        "",
        "Coefficients of the last model (elasticities: 1 % more of x → β % more boardings):",
        "",
        "| Term | β |",
        "|---|---|",
        *(f"| {k} | {v:.2f} |" for k, v in full.items()),
        "",
        "## Biggest residuals (last model)",
        "",
        "Riders vs. what frequency and catchment predict; × = observed ÷ predicted.",
        "",
    ]
    pred = np.expm1(y - resid)
    order = np.argsort(resid)
    for title, ids in (("More riders than expected", order[::-1][:10]), ("Fewer", order[:10])):
        lines += [f"**{title}**", "", "| Stop | Boardings | Predicted | × |", "|---|---|---|---|"]
        for i in ids:
            lines.append(
                f"| {names[i]} | {b[i]:.0f} | {pred[i]:.0f} | {(b[i] + 1) / (pred[i] + 1):.1f} |"
            )
        lines.append("")
    return "\n".join(lines)


def validate() -> None:
    text = report(load())
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(text + "\n")
    print(text)
    print(f"\nwrote {OUT.relative_to(config.REPO)}")
