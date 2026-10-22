// Catchment scores and frequencies, computed in the browser from stops.json so the
// weights and the service period apply instantly. The walk limit and decay are fixed by
// the pipeline (pipeline.toml [score]); the decay stays general for the blob shading.

import { type Period, PERIODS, type Stop, type StopsFile } from './contract'

export type DecayKind = 'none' | 'linear' | 'exponential' | 'logistic'

export interface Decay {
  kind: DecayKind
  /** exponential: half-life (minutes); logistic: midpoint (minutes). */
  param: number
}

/** Weight of something t minutes' walk away (cutoff: the walk-time limit). */
export function decayWeight(d: Decay, t: number, cutoff: number): number {
  if (t > cutoff) {
    return 0
  }
  switch (d.kind) {
    case 'none':
      return 1
    case 'linear':
      return Math.max(0, 1 - t / cutoff)
    case 'exponential':
      return Math.pow(0.5, t / Math.max(d.param, 0.1))
    case 'logistic':
      // Steepness scales with the midpoint so the curve keeps its shape.
      return 1 / (1 + Math.exp((t - d.param) / Math.max(d.param / 6, 0.2)))
  }
}

/** Per-band weights: band i covers (i, i+1] minutes x band_min; weighted at its middle. */
export function bandWeights(d: Decay, cutoff: number, nBands: number, bandMin: number): number[] {
  return [...Array(nBands).keys()].map((i) =>
    (i + 1) * bandMin <= cutoff + 1e-9 ? decayWeight(d, (i + 0.5) * bandMin, cutoff) : 0,
  )
}

/** Score weights: homes (residents), jobs, other destinations. */
export interface Weights {
  pop: number
  jobs: number
  dest: number
}

export interface Settings {
  walkMin: number
  decay: Decay
  weights: Weights
  period: Period | 'aggregate'
  periodWeights: Record<Period, number>
  /** Destination points per retail/health-care job (stops.json settings.score). */
  shopJobsWeight: number
}

/** Pseudo-category for the retail and health-care jobs part of other destinations. */
export const SHOP_JOBS = 'shops and clinics'

export interface Components {
  pop: number
  jobs: number
  /** Destination points over categories plus weighted retail/health-care jobs. */
  dest: number
  /** Points per category (and SHOP_JOBS), before the destinations weight. */
  categories: Record<string, number>
}

export interface Scored {
  stop: Stop
  raw: Components
  /** 0-100 against the best stop at the same settings. */
  norm: { pop: number; jobs: number; dest: number }
  score: number
  /** Trips per hour in the chosen period (per direction, all routes). */
  freq: number
  /** Observed / expected weekday boardings (ridersRatio); null without data. */
  riders: number | null
  /** Share of the stop's catchment (default walk, current weights) that no other stop on
   * its routes serves as well, 0-1; null without route data. */
  adds: number | null
  rank: number
}

export function rawComponents(
  stop: Stop,
  bw: number[],
  poiCategories: string[],
  shopJobsWeight: number,
): Components {
  function sum(id: string): number {
    const v = stop.bands[id] ?? []
    let s = 0
    for (let i = 0; i < bw.length; i++) {
      s += (v[i] ?? 0) * (bw[i] ?? 0)
    }
    return s
  }
  const categories: Record<string, number> = {}
  for (const cat of poiCategories) {
    categories[cat] = sum(cat)
  }
  categories[SHOP_JOBS] = sum('shopjobs') * shopJobsWeight
  const dest = Object.values(categories).reduce((a, b) => a + b, 0)
  return { pop: sum('pop'), jobs: sum('jobs'), dest, categories }
}

/** Observed / expected weekday boardings, smoothed by k so stops with a handful of
 * riders stay near 1; null without ridership data. */
export function ridersRatio(stop: Stop, k: number): number | null {
  const r = stop.riders
  return r ? (r.observed + k) / (r.expected + k) : null
}

/** Trips per hour at a stop for one period: each route's directions averaged, summed. */
export function periodFreq(stop: Stop, period: Period): number {
  const byRoute = stop.freq[period] ?? {}
  return Object.values(byRoute).reduce((a, b) => a + b, 0)
}

export function stopFreq(stop: Stop, s: Settings): number {
  if (s.period !== 'aggregate') {
    return periodFreq(stop, s.period)
  }
  let num = 0
  let den = 0
  for (const p of PERIODS) {
    num += s.periodWeights[p] * periodFreq(stop, p)
    den += s.periodWeights[p]
  }
  return den > 0 ? num / den : 0
}

export function scoreAll(data: StopsFile, s: Settings): Scored[] {
  const nBands = data.settings.max_walk_min / data.settings.band_min
  const bw = bandWeights(s.decay, s.walkMin, nBands, data.settings.band_min)
  const cats = data.measures.filter((m) => m.kind === 'poi').map((m) => m.id)
  const raws = data.stops.map((stop) => rawComponents(stop, bw, cats, s.shopJobsWeight))
  function max(k: 'pop' | 'jobs' | 'dest'): number {
    return Math.max(1e-9, ...raws.map((r) => r[k]))
  }
  const mPop = max('pop')
  const mJobs = max('jobs')
  const mDest = max('dest')
  const w = s.weights
  const wSum = w.pop + w.jobs + w.dest
  // What each stop adds: its added totals over its full ones, each component normalized
  // by the largest full total (as the score is), combined with the current weights.
  const kShop = data.settings.score.shop_jobs_weight
  function ov(stop: Stop, key: 'full' | 'added'): [number, number, number] {
    const o = stop.overlap?.[key] ?? {}
    return [o.pop ?? 0, o.jobs ?? 0, (o.poi ?? 0) + kShop * (o.shopjobs ?? 0)]
  }
  const ovMax = [0, 1, 2].map((i) =>
    Math.max(1e-9, ...data.stops.map((stop) => ov(stop, 'full')[i] ?? 0)),
  )
  const ovW = [s.weights.pop, s.weights.jobs, s.weights.dest]
  function adds(stop: Stop): number | null {
    if (!stop.overlap) {
      return null
    }
    const f = ov(stop, 'full')
    const a = ov(stop, 'added')
    let num = 0
    let den = 0
    for (let i = 0; i < 3; i++) {
      num += ((ovW[i] ?? 0) * (a[i] ?? 0)) / (ovMax[i] ?? 1)
      den += ((ovW[i] ?? 0) * (f[i] ?? 0)) / (ovMax[i] ?? 1)
    }
    return den > 0 ? num / den : null
  }
  const scored = data.stops.map((stop, i) => {
    const raw = raws[i]
    const norm = {
      pop: (100 * raw.pop) / mPop,
      jobs: (100 * raw.jobs) / mJobs,
      dest: (100 * raw.dest) / mDest,
    }
    const score = wSum > 0 ? (w.pop * norm.pop + w.jobs * norm.jobs + w.dest * norm.dest) / wSum : 0
    const riders = ridersRatio(stop, data.settings.fit.ratio_k)
    return { stop, raw, norm, score, freq: stopFreq(stop, s), riders, adds: adds(stop), rank: 0 }
  })
  const order = [...scored].sort((a, b) => b.score - a.score)
  order.forEach((x, i) => {
    x.rank = i + 1
  })
  return scored
}
