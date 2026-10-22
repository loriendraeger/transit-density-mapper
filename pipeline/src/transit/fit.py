"""Calibrate the catchment score against observed boardings (valid.cluster_ridership).

The site's score is a weighted sum of decay-weighted catchment totals (population,
jobs, destinations), normalized against the best stop (site/src/lib/scoring.ts). Here
the same formula is fit to observed weekday boardings per trip, a stop's riders per
unit of service, so frequency doesn't get credited to the catchment:

    boardings / freq ~ b0 + w_pop * pop + w_jobs * jobs + w_dest * dest

with non-negative weights, the exponential half-life and the walk limit searched over
whole minutes. Fit by least squares on log(1 + .) so the few huge stops (campus) don't
decide everything. Special stops (valid.special: schools, campus, park-and-rides,
airport, transfer points) and stops with little service stay out of the fit.

Outputs:
- valid.fit_params: the fitted settings, with the weights scaled for the site's 0-5
  sliders (they act on catchment totals normalized against the best stop)
- valid.stop_fit: per stop, observed boardings and the fit's expected boardings
  (freq * (b0 + w . x)), the basis of the site's "riders vs. expected"
- data/build/validation/ridership.md: correlations at the site defaults, the fit, and
  the biggest residuals
"""

import math

import numpy as np
import psycopg
from psycopg.rows import dict_row
from scipy.optimize import minimize
from scipy.stats import spearmanr

from . import config

OUT = config.BUILD / "validation" / "ridership.md"
COMPONENTS = ("pop", "jobs", "dest")
# Site defaults (site/src/state/store.ts), for the "as shipped" comparison.
DEFAULT_WALK_MIN = 10
DEFAULT_HALF_LIFE = 8
# Boardings are weekday averages, so frequency is the weekday mix.
WEEKDAY_PERIODS = ("peak", "offpeak")
SLIDER_MAX = 5
SLIDER_STEP = 0.5
CV_FOLDS = 5
# Riders vs. expected = (boardings + k) / (expected + k): pulls stops with only a few
# riders toward 1, so 14 vs. 0 doesn't read as 15x. The site uses the same k.
RATIO_K = 5


def band_weights(n_bands: int, band_min: float, walk_min: float, half_life: float) -> np.ndarray:
    """Exponential decay at each band's middle, zero past the walk limit (bandWeights)."""
    return np.array(
        [
            0.5 ** ((i + 0.5) * band_min / half_life)
            if (i + 1) * band_min <= walk_min + 1e-9
            else 0.0
            for i in range(n_bands)
        ]
    )


def load() -> dict:
    p = config.pipeline()
    band_min = p["walk"]["band_min"]
    n_bands = math.ceil(p["walk"]["max_walk_min"] / band_min)
    f = p["frequency"]
    period_w = {"peak": f["weight_peak"], "offpeak": f["weight_offpeak"]}
    with psycopg.connect("", row_factory=dict_row) as conn:
        # The stops the site has: those with a catchment.
        stops = conn.execute(
            "SELECT c.cluster_id AS id, c.name, r.boardings, s.reasons "
            "FROM transit.clusters c "
            "LEFT JOIN valid.cluster_ridership r USING (cluster_id) "
            "LEFT JOIN valid.special s USING (cluster_id) "
            "WHERE EXISTS (SELECT 1 FROM catch.reach x WHERE x.cluster_id = c.cluster_id) "
            "ORDER BY c.cluster_id"
        ).fetchall()
        idx = {s["id"]: i for i, s in enumerate(stops)}
        # bands[stop, band, component]
        bands = np.zeros((len(stops), n_bands, len(COMPONENTS)))
        for r in conn.execute("SELECT cluster_id, band, measure, value FROM catch.bands"):
            i = idx.get(r["cluster_id"])
            if i is None or r["band"] > n_bands:
                continue
            k = COMPONENTS.index(r["measure"]) if r["measure"] in ("pop", "jobs") else 2
            bands[i, r["band"] - 1, k] += r["value"]
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
    boardings = np.array([np.nan if s["boardings"] is None else s["boardings"] for s in stops])
    return {
        "stops": stops,
        "bands": bands,
        "band_min": band_min,
        "freq": freq,
        "boardings": boardings,
        "special": np.array([s["reasons"] is not None for s in stops]),
        "match": match,
        "unmatched_top": unmatched_top,
        "fit_min_freq": p["ridership"]["fit_min_freq"],
        "hl_range": p["ridership"]["fit_half_life_range"],
        "walk_range": p["ridership"]["fit_walk_min_range"],
    }


def components(d: dict, walk_min: float, half_life: float) -> np.ndarray:
    """Decay-weighted catchment totals, [stop, component]."""
    bw = band_weights(d["bands"].shape[1], d["band_min"], walk_min, half_life)
    return np.einsum("nbk,b->nk", d["bands"], bw)


def site_score(x: np.ndarray, weights: np.ndarray) -> np.ndarray:
    """The site's score: components normalized 0-100 against the best stop, averaged."""
    norm = 100 * x / np.maximum(x.max(axis=0), 1e-9)
    return norm @ weights / weights.sum()


def fit_log(x: np.ndarray, y: np.ndarray) -> tuple[np.ndarray, float]:
    """Non-negative [b0, w...] minimizing sum (log1p(y) - log1p(b0 + x w))^2; x scaled
    to its max per column. Returns params (in scaled units) and R² on the log scale."""
    ly = np.log1p(y)
    x1 = np.column_stack([np.ones(len(x)), x])

    def loss(q: np.ndarray) -> tuple[float, np.ndarray]:
        # exp keeps the parameters positive; the clip keeps a wandering start finite.
        p = np.exp(np.clip(q, -30, 30))
        z = x1 @ p
        r = ly - np.log1p(z)
        # d/dq: -2 r / (1 + z) * x, times dp/dq = p
        return float((r**2).sum()), (-2 * r / (1 + z)) @ x1 * p

    best = None
    for start in ([0.0] * 4, [1.0] * 4, [1.0, 3.0, 0.0, 2.0]):
        r = minimize(loss, np.array(start), jac=True, method="L-BFGS-B")
        if best is None or r.fun < best.fun:
            best = r
    return np.exp(best.x), 1 - best.fun / ((ly - ly.mean()) ** 2).sum()


def fit_model(d: dict) -> dict:
    b, freq = d["boardings"], d["freq"]
    in_fit = ~np.isnan(b) & (freq >= d["fit_min_freq"]) & ~d["special"]
    y = b[in_fit] / freq[in_fit]
    grid = []
    for walk_min in range(d["walk_range"][0], d["walk_range"][1] + 1):
        for hl in range(d["hl_range"][0], d["hl_range"][1] + 1):
            x = components(d, walk_min, hl)[in_fit]
            scale = np.maximum(x.max(axis=0), 1e-9)
            params, r2 = fit_log(x / scale, y)
            grid.append({"walk_min": walk_min, "half_life": hl, "r2": r2, "params": params})
    best = max(grid, key=lambda g: g["r2"])
    default = next(
        g for g in grid if g["walk_min"] == DEFAULT_WALK_MIN and g["half_life"] == DEFAULT_HALF_LIFE
    )
    x_all = components(d, best["walk_min"], best["half_life"])
    scale = np.maximum(x_all[in_fit].max(axis=0), 1e-9)
    b0, w = best["params"][0], best["params"][1:]
    per_trip = b0 + (x_all / scale) @ w
    expected = freq * per_trip

    # Site sliders act on totals normalized against the best of all stops, so a fitted
    # weight per unit of x becomes w / scale * max(all stops); then fit 0-5 sliders.
    site_w = w / scale * np.maximum(x_all.max(axis=0), 1e-9)
    site_w = np.round(site_w / site_w.max() * SLIDER_MAX / SLIDER_STEP) * SLIDER_STEP

    # Cross-validated R² at the chosen settings (weights refit on each training fold).
    rng = np.random.default_rng(0)
    folds = rng.permutation(in_fit.sum()) % CV_FOLDS
    xf = x_all[in_fit] / scale
    sse = sst = 0.0
    for k in range(CV_FOLDS):
        tr, te = folds != k, folds == k
        p, _ = fit_log(xf[tr], y[tr])
        ly = np.log1p(y[te])
        sse += ((ly - np.log1p(p[0] + xf[te] @ p[1:])) ** 2).sum()
        sst += ((ly - np.log1p(y[tr]).mean()) ** 2).sum()
    return {
        "in_fit": in_fit,
        "grid": grid,
        "best": best,
        "default": default,
        "site_weights": site_w,
        "expected": expected,
        "cv_r2": 1 - sse / sst,
        "x": x_all,
    }


def write_db(d: dict, m: dict) -> None:
    best = m["best"]
    params = {
        "walk_min": best["walk_min"],
        "half_life": best["half_life"],
        "w_pop": m["site_weights"][0],
        "w_jobs": m["site_weights"][1],
        "w_dest": m["site_weights"][2],
        "r2": best["r2"],
        "cv_r2": m["cv_r2"],
        "n_fit": int(m["in_fit"].sum()),
        "ratio_k": RATIO_K,
    }
    with psycopg.connect("") as conn:
        conn.execute("DROP TABLE IF EXISTS valid.fit_params")
        conn.execute("CREATE TABLE valid.fit_params (key text PRIMARY KEY, value float8)")
        with conn.cursor().copy("COPY valid.fit_params FROM STDIN") as cp:
            for k, v in params.items():
                cp.write_row([k, float(v)])
        conn.execute("DROP TABLE IF EXISTS valid.stop_fit")
        conn.execute(
            "CREATE TABLE valid.stop_fit (cluster_id text PRIMARY KEY, boardings float8, "
            "expected float8, in_fit boolean)"
        )
        with conn.cursor().copy("COPY valid.stop_fit FROM STDIN") as cp:
            for i, s in enumerate(d["stops"]):
                b = d["boardings"][i]
                cp.write_row(
                    [
                        s["id"],
                        None if np.isnan(b) else float(b),
                        float(m["expected"][i]),
                        bool(m["in_fit"][i]),
                    ]
                )


def report(d: dict, m: dict) -> str:
    has = ~np.isnan(d["boardings"])
    b, freq = d["boardings"][has], d["freq"][has]
    m_ = d["match"]
    x_def = components(d, DEFAULT_WALK_MIN, DEFAULT_HALF_LIFE)
    score = site_score(x_def, np.ones(3))[has]
    best, default = m["best"], m["default"]
    fitted_score = site_score(m["x"], np.maximum(m["site_weights"], 1e-9))[has]
    names = [f"{s['name']} ({s['id']})" for s in d["stops"]]
    reasons = [", ".join(s["reasons"] or []) for s in d["stops"]]
    lines = [
        "# Catchment score vs. observed boardings",
        "",
        "Weekday boardings: Greater Madison MPO, February 2024 (farebox + AVL estimates;",
        "before the BRT opened in September 2024). Frequency: weekday peak/off-peak mix, per",
        "direction, from the current feed.",
        "",
        "## Matching",
        "",
        f"- {m_['matched']} of {m_['n']} MPO stops matched to a current platform "
        f"({m_['by_nearest']} by position); unmatched hold {m_['unmatched']:.0f} of "
        f"{m_['total']:.0f} boardings ({100 * m_['unmatched'] / m_['total']:.1f} %). Largest: "
        + ", ".join(f"{r['stop_name']} ({r['boardings']})" for r in d["unmatched_top"])
        + ".",
        f"- {has.sum()} of {len(has)} merged stops have a boardings figure; the other "
        f"{(~has).sum()} are new or moved since 2024.",
        f"- {d['special'].sum()} special stops (school, campus, park-and-ride, airport, "
        f"transfer) and stops under {d['fit_min_freq']} trips/h stay out of the fit: "
        f"{m['in_fit'].sum()} stops are fit.",
        "",
        "## Rank correlation with boardings (Spearman ρ), all stops with data",
        "",
        "| Measure | ρ |",
        "|---|---|",
    ]
    rows = [
        ("Score, site defaults (10 min, 8 min half-life, 1:1:1)", score, b),
        ("Score, fitted settings", fitted_score, b),
        ("Frequency (trips/h per direction)", freq, b),
        ("Expected boardings (fit × frequency)", m["expected"][has], b),
        ("Score (defaults) vs. boardings per trip/h", score, b / np.maximum(freq, 0.1)),
    ]
    for label, x, y in rows:
        lines.append(f"| {label} | {spearmanr(x, y).statistic:.2f} |")
    by_walk: dict[int, dict] = {}
    for g in m["grid"]:
        if g["walk_min"] not in by_walk or g["r2"] > by_walk[g["walk_min"]]["r2"]:
            by_walk[g["walk_min"]] = g
    sw = m["site_weights"]
    lines += [
        "",
        "## Fit: boardings per trip/h ~ b0 + weights · catchment (log scale)",
        "",
        f"- Best: walk limit {best['walk_min']} min, half-life {best['half_life']} min, "
        f"R² {best['r2']:.3f} ({CV_FOLDS}-fold cross-validated {m['cv_r2']:.3f}); at the "
        f"site defaults R² {default['r2']:.3f}.",
        f"- Site weights (0–{SLIDER_MAX} sliders): population {sw[0]:g}, jobs {sw[1]:g}, "
        f"destinations {sw[2]:g}.",
        "",
        "Best R² per walk limit (half-life searched):",
        "",
        "| Walk limit (min) | Half-life (min) | R² |",
        "|---|---|---|",
        *(f"| {w} | {g['half_life']} | {g['r2']:.3f} |" for w, g in sorted(by_walk.items())),
        "",
        "## Riders vs. expected (fitted model × frequency)",
        "",
    ]
    ratio = (d["boardings"] + RATIO_K) / (m["expected"] + RATIO_K)
    idx = np.flatnonzero(has)
    order = idx[np.argsort(ratio[idx])]
    for title, ids in (("More riders than expected", order[::-1][:15]), ("Fewer", order[:15])):
        lines += [
            f"**{title}**",
            "",
            "| Stop | Boardings | Expected | × | Special |",
            "|---|---|---|---|---|",
        ]
        for i in ids:
            lines.append(
                f"| {names[i]} | {d['boardings'][i]:.0f} | {m['expected'][i]:.0f} | "
                f"{ratio[i]:.2f} | {reasons[i]} |"
            )
        lines.append("")
    return "\n".join(lines)


def fit() -> None:
    d = load()
    m = fit_model(d)
    write_db(d, m)
    text = report(d, m)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(text + "\n")
    print(text)
    print(f"\nwrote {OUT.relative_to(config.REPO)}")
