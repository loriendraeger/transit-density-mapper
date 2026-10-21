// Catchment scores and frequencies, computed in the browser from stops.json so every
// setting (walk time, decay, weights, period) applies instantly.

import { type Period, PERIODS, type Stop, type StopsFile } from './contract'

export type DecayKind = 'none' | 'linear' | 'exponential' | 'logistic'

export interface Decay {
  kind: DecayKind
  /** exponential: half-life (minutes); logistic: midpoint (minutes). */
  param: number
}

export const DECAYS: Record<DecayKind, { label: string; param?: string; hint: string }> = {
  none: { label: 'None', hint: 'Everything within the walk time counts fully.' },
  linear: {
    label: 'Linear',
    hint: 'Weight falls in a straight line from 1 at the stop to 0 at the walk-time limit.',
  },
  exponential: {
    label: 'Exponential',
    param: 'Half-life (min)',
    hint: 'Weight halves every half-life: steep near the stop, long tail.',
  },
  logistic: {
    label: 'S-curve',
    param: 'Midpoint (min)',
    hint: 'Close to 1 until near the midpoint, then drops off quickly.',
  },
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

export interface Weights {
  pop: number
  jobs: number
  dest: number
  /** POI category -> weight within destinations. */
  categories: Record<string, number>
}

export interface Settings {
  walkMin: number
  decay: Decay
  weights: Weights
  period: Period | 'aggregate'
  periodWeights: Record<Period, number>
}

export interface Components {
  pop: number
  jobs: number
  /** Weighted sum of destination points over categories. */
  dest: number
  /** Per-category weighted points (before the destinations weight). */
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
  rank: number
}

export function rawComponents(stop: Stop, bw: number[], weights: Weights): Components {
  function sum(id: string): number {
    const v = stop.bands[id] ?? []
    let s = 0
    for (let i = 0; i < bw.length; i++) {
      s += (v[i] ?? 0) * (bw[i] ?? 0)
    }
    return s
  }
  const categories: Record<string, number> = {}
  let dest = 0
  for (const [cat, w] of Object.entries(weights.categories)) {
    const v = sum(cat) * w
    categories[cat] = v
    dest += v
  }
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
  const raws = data.stops.map((stop) => rawComponents(stop, bw, s.weights))
  function max(k: 'pop' | 'jobs' | 'dest'): number {
    return Math.max(1e-9, ...raws.map((r) => r[k]))
  }
  const mPop = max('pop')
  const mJobs = max('jobs')
  const mDest = max('dest')
  const w = s.weights
  const wSum = w.pop + w.jobs + w.dest
  const scored = data.stops.map((stop, i) => {
    const raw = raws[i]
    const norm = {
      pop: (100 * raw.pop) / mPop,
      jobs: (100 * raw.jobs) / mJobs,
      dest: (100 * raw.dest) / mDest,
    }
    const score = wSum > 0 ? (w.pop * norm.pop + w.jobs * norm.jobs + w.dest * norm.dest) / wSum : 0
    const riders = ridersRatio(stop, data.settings.fit.ratio_k)
    return { stop, raw, norm, score, freq: stopFreq(stop, s), riders, rank: 0 }
  })
  const order = [...scored].sort((a, b) => b.score - a.score)
  order.forEach((x, i) => {
    x.rank = i + 1
  })
  return scored
}
