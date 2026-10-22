"""Calibrate the catchment score against observed boardings (valid.cluster_ridership).

The site's score is a weighted sum of decay-weighted catchment totals (homes, jobs,
other destinations), normalized against the best stop (site/src/lib/scoring.ts), at
fixed settings (pipeline.toml [score]: walk limit, exponential half-life). Here the same
formula is fit to observed weekday boardings per trip, a stop's riders per unit of
service, so frequency doesn't get credited to the catchment:

    boardings / freq ~ b0 + w_pop * pop + w_jobs * jobs + w_osm * osm + w_shop * shop_jobs

with non-negative weights, by least squares on log(1 + .) so the few huge stops (campus)
don't decide everything. osm = OSM destination points (category totals from trip
purposes); shop_jobs = retail and health-care jobs, which size shops and clinics. The
site folds both into one "other destinations" term, osm + k * shop_jobs, with k = the
fitted ratio (points per shop job). Special stops (valid.special: schools, campus,
park-and-rides, airport, transfer points) and stops with little service stay out.

Outputs:
- valid.fit_params: default slider weights (homes, jobs, destinations; 0-5, fitted and
  rounded), k, R² (in-sample and cross-validated)
- valid.stop_fit: per stop, observed boardings and the fit's expected boardings
  (freq * (b0 + w . x)), the basis of the site's "riders vs. expected"
- data/build/validation/ridership.md: the fit, a half-life comparison, correlations and
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
COMPONENTS = ("pop", "jobs", "osm", "shopjobs")
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
        # bands[stop, band, component]; every POI category counts toward osm.
        bands = np.zeros((len(stops), n_bands, len(COMPONENTS)))
        for r in conn.execute("SELECT cluster_id, band, measure, value FROM catch.bands"):
            i = idx.get(r["cluster_id"])
            if i is None or r["band"] > n_bands:
                continue
            m = r["measure"]
            k = COMPONENTS.index(m) if m in COMPONENTS else COMPONENTS.index("osm")
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
        "walk_min": p["score"]["walk_min"],
        "half_life": p["score"]["half_life_min"],
    }


def components(d: dict, walk_min: float, half_life: float) -> np.ndarray:
    """Decay-weighted catchment totals, [stop, component]."""
    bw = band_weights(d["bands"].shape[1], d["band_min"], walk_min, half_life)
    return np.einsum("nbk,b->nk", d["bands"], bw)


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
    for start in (0.0, 1.0, -2.0):
        r = minimize(loss, np.full(x1.shape[1], start), jac=True, method="L-BFGS-B")
        if best is None or r.fun < best.fun:
            best = r
    return np.exp(np.clip(best.x, -30, 30)), 1 - best.fun / ((ly - ly.mean()) ** 2).sum()


def cv_r2(x: np.ndarray, y: np.ndarray, seed: int = 0) -> float:
    """Cross-validated R² (weights refit on each training fold)."""
    folds = np.random.default_rng(seed).permutation(len(y)) % CV_FOLDS
    sse = sst = 0.0
    for k in range(CV_FOLDS):
        tr, te = folds != k, folds == k
        p, _ = fit_log(x[tr], y[tr])
        ly = np.log1p(y[te])
        sse += ((ly - np.log1p(p[0] + x[te] @ p[1:])) ** 2).sum()
        sst += ((ly - np.log1p(y[tr]).mean()) ** 2).sum()
    return 1 - sse / sst


def fit_model(d: dict) -> dict:
    b, freq = d["boardings"], d["freq"]
    in_fit = ~np.isnan(b) & (freq >= d["fit_min_freq"]) & ~d["special"]
    y = b[in_fit] / freq[in_fit]

    def at(half_life: float) -> dict:
        x_all = components(d, d["walk_min"], half_life)
        scale = np.maximum(x_all[in_fit].max(axis=0), 1e-9)
        params, r2 = fit_log(x_all[in_fit] / scale, y)
        return {"x": x_all, "scale": scale, "params": params, "r2": r2}

    m = at(d["half_life"])
    x_all, scale, params = m["x"], m["scale"], m["params"]
    b0, w = params[0], params[1:] / scale  # weights per raw unit
    expected = freq * (b0 + x_all @ w)
    pop_w, jobs_w, osm_w, shop_w = w
    # One "other destinations" term: osm + k * shop_jobs.
    k_shop = shop_w / max(osm_w, 1e-12)
    dest = x_all[:, 2] + k_shop * x_all[:, 3]
    # Site sliders act on totals normalized against the best of all stops: a raw-unit
    # weight times that maximum, then scaled to the 0-5 sliders.
    site_w = np.array([pop_w, jobs_w, osm_w]) * np.array(
        [x_all[:, 0].max(), x_all[:, 1].max(), dest.max()]
    )
    site_w = np.round(site_w / site_w.max() * SLIDER_MAX / SLIDER_STEP) * SLIDER_STEP
    profile = [
        {"half_life": h, "r2": at(h)["r2"]} for h in range(d["hl_range"][0], d["hl_range"][1] + 1)
    ]

    # Best fit: the walk limit and half-life that predict boardings best, with other
    # destinations defined as above (osm + k * shop jobs, k fixed), weights refit.
    def three(walk_min: float, half_life: float) -> np.ndarray:
        x = components(d, walk_min, half_life)
        return np.column_stack([x[:, 0], x[:, 1], x[:, 2] + k_shop * x[:, 3]])

    grid = []
    for walk_min in range(d["walk_range"][0], d["walk_range"][1] + 1):
        for hl in range(d["hl_range"][0], d["hl_range"][1] + 1):
            x3 = three(walk_min, hl)
            sc = np.maximum(x3[in_fit].max(axis=0), 1e-9)
            p3, r2 = fit_log(x3[in_fit] / sc, y)
            grid.append(
                {"walk_min": walk_min, "half_life": hl, "r2": r2, "p": p3, "sc": sc, "x": x3}
            )
    best = max(grid, key=lambda g: g["r2"])
    best_w = best["p"][1:] / best["sc"] * best["x"].max(axis=0)
    best_w = np.round(best_w / best_w.max() * SLIDER_MAX / SLIDER_STEP) * SLIDER_STEP
    best_fit = {
        "walk_min": best["walk_min"],
        "half_life": best["half_life"],
        "weights": best_w,
        "r2": best["r2"],
        "cv_r2": cv_r2(best["x"][in_fit] / best["sc"], y),
    }
    return {
        "in_fit": in_fit,
        "r2": m["r2"],
        "cv_r2": cv_r2(x_all[in_fit] / scale, y),
        "site_weights": site_w,
        "k_shop": k_shop,
        "expected": expected,
        "dest": dest,
        "x": x_all,
        "profile": profile,
        "grid": grid,
        "best_fit": best_fit,
    }


def write_db(d: dict, m: dict) -> None:
    params = {
        "walk_min": d["walk_min"],
        "half_life": d["half_life"],
        "w_pop": m["site_weights"][0],
        "w_jobs": m["site_weights"][1],
        "w_dest": m["site_weights"][2],
        "shop_jobs_weight": m["k_shop"],
        "r2": m["r2"],
        "cv_r2": m["cv_r2"],
        "n_fit": int(m["in_fit"].sum()),
        "ratio_k": RATIO_K,
        "best_walk_min": m["best_fit"]["walk_min"],
        "best_half_life": m["best_fit"]["half_life"],
        "best_w_pop": m["best_fit"]["weights"][0],
        "best_w_jobs": m["best_fit"]["weights"][1],
        "best_w_dest": m["best_fit"]["weights"][2],
        "best_r2": m["best_fit"]["r2"],
        "best_cv_r2": m["best_fit"]["cv_r2"],
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
    x = m["x"]
    norm = np.column_stack([x[:, 0], x[:, 1], m["dest"]])
    norm = 100 * norm / np.maximum(norm.max(axis=0), 1e-9)
    sw = m["site_weights"]
    score = (norm @ sw / sw.sum())[has]
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
        "## Fit: boardings per trip/h ~ b0 + weights · catchment (log scale)",
        "",
        f"- Settings (pipeline.toml [score]): walk limit {d['walk_min']} min, half-life "
        f"{d['half_life']} min.",
        f"- R² {m['r2']:.3f} ({CV_FOLDS}-fold cross-validated {m['cv_r2']:.3f}).",
        f"- Default sliders (0–{SLIDER_MAX}): homes {sw[0]:g}, jobs {sw[1]:g}, other "
        f"destinations {sw[2]:g}.",
        f"- Other destinations = OSM destination points + {m['k_shop']:.3f} × retail and "
        "health-care jobs.",
        "",
        f"- Best fit (site preset; walk {d['walk_range'][0]}–{d['walk_range'][1]} min, "
        f"half-life {d['hl_range'][0]}–{d['hl_range'][1]} min searched): walk limit "
        f"{m['best_fit']['walk_min']} min, half-life {m['best_fit']['half_life']} min, "
        f"weights {', '.join(f'{v:g}' for v in m['best_fit']['weights'])}; R² "
        f"{m['best_fit']['r2']:.3f} (cross-validated {m['best_fit']['cv_r2']:.3f}).",
        "",
        "Best R² per walk limit (half-life searched):",
        "",
        "| Walk limit (min) | Half-life (min) | R² |",
        "|---|---|---|",
        *(
            f"| {w} | {g['half_life']} | {g['r2']:.3f} |"
            for w, g in sorted(
                {
                    w: max((g for g in m["grid"] if g["walk_min"] == w), key=lambda g: g["r2"])
                    for w in {g["walk_min"] for g in m["grid"]}
                }.items()
            )
        ),
        "",
        f"R² by half-life at the {d['walk_min']} min limit (for comparison):",
        "",
        "| Half-life (min) | R² |",
        "|---|---|",
        *(f"| {p['half_life']} | {p['r2']:.3f} |" for p in m["profile"]),
        "",
        "## Rank correlation with boardings (Spearman ρ), all stops with data",
        "",
        "| Measure | ρ |",
        "|---|---|",
    ]
    rows = [
        ("Score at the defaults", score, b),
        ("Frequency (trips/h per direction)", freq, b),
        ("Expected boardings (fit × frequency)", m["expected"][has], b),
        ("Score vs. boardings per trip/h", score, b / np.maximum(freq, 0.1)),
    ]
    for label, xs, ys in rows:
        lines.append(f"| {label} | {spearmanr(xs, ys).statistic:.2f} |")
    lines += ["", "## Riders vs. expected (fitted model × frequency)", ""]
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
