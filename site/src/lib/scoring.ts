// Catchment scores and frequencies, computed in the browser from stops.json so the
// settings and the service period apply instantly. Two score models:
//   potential  trip ends a day by all modes within the walk (NHTS rates per resident,
//              job and destination point; stops.json settings.potential), not fit to
//              ridership: where people live and go, irrespective of mode
//   tuned      the weighted 0-100 score with weights fit to today's boardings
// The decay stays general for the blob shading.

import { type Period, PERIODS, type ScoreSettings, type Stop, type StopsFile } from './contract'

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

/** Score weights: homes (residents), jobs, other destinations (all within walking
 * distance) and transit connections (reachable by riding). */
export interface Weights {
  pop: number
  jobs: number
  dest: number
  transit: number
}

/** Which score the site shows (see the top of this file). */
export type Model = 'potential' | 'tuned'

export interface Settings {
  model: Model
  walkMin: number
  decay: Decay
  weights: Weights
  period: Period | 'aggregate'
  periodWeights: Record<Period, number>
  /** Destination points per retail/health-care job (stops.json settings.score). */
  shopJobsWeight: number
  /** Destination points per school trip end (stops.json settings.score). */
  schoolWeight: number
}

/** Pseudo-category for the retail and health-care jobs part of other destinations. */
export const SHOP_JOBS = 'shops and clinics'
/** Pseudo-category for school trip ends (enrollment), part of other destinations. */
export const SCHOOLS = 'schools and colleges'

export interface Components {
  pop: number
  jobs: number
  /** Destination points over categories plus weighted retail/health-care jobs. */
  dest: number
  /** Points per category (and SHOP_JOBS), before the destinations weight. */
  categories: Record<string, number>
  /** Jobs and other destinations reachable by transit, discounted by travel time. */
  transit: number
}

export interface Scored {
  stop: Stop
  raw: Components
  /** 0-100 against the best stop at the same settings. */
  norm: { pop: number; jobs: number; dest: number; transit: number }
  /** Potential: decay-weighted trip ends a day by all modes, per component and total. */
  trips: { pop: number; jobs: number; dest: number }
  potential: number
  /** The active model's score: potential (trip ends a day) or the tuned 0-100 score. */
  score: number
  /** Potential per weekday bus (trip ends / departures per direction in the weekday
   * periods), relative to the median stop; null without weekday service. */
  perBus: number | null
  /** Trips per hour in the chosen period (per direction, all routes). */
  freq: number
  /** Observed / expected weekday boardings (ridersRatio); null without data. */
  riders: number | null
  /** Share of the stop's catchment (default walk; trip ends, or the tuned weights) that
   * no other stop on its routes serves as well, 0-1; null without route data. */
  adds: number | null
  /** Potential: trip ends a day that only this stop serves as well (default walk). */
  addsTrips: number | null
  rank: number
}

export function rawComponents(
  stop: Stop,
  bw: number[],
  poiCategories: string[],
  shopJobsWeight: number,
  schoolWeight: number,
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
  categories[SCHOOLS] = sum('school') * schoolWeight
  const dest = Object.values(categories).reduce((a, b) => a + b, 0)
  return { pop: sum('pop'), jobs: sum('jobs'), dest, categories, transit: 0 }
}

/** Transit connections: each travel-time band's jobs and other destinations reached,
 * weighted 0.5^(t / half-life) at the band's middle and mixed at the fitted weights. */
export function transitRaw(stop: Stop, a: ScoreSettings['access'], shopJobsWeight: number): number {
  const acc = stop.access
  if (!acc) {
    return 0
  }
  let s = 0
  for (let b = 0; b < acc.jobs.length; b++) {
    const g = Math.pow(0.5, ((b + 0.5) * a.band_min) / a.half_life_min)
    const dest = (acc.osm[b] ?? 0) + shopJobsWeight * (acc.shopjobs[b] ?? 0)
    s += g * (a.jobs_weight * (acc.jobs[b] ?? 0) + a.dest_weight * dest)
  }
  return s
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

/** Weekday departures per direction (all routes) over the weekday periods' windows. */
export function weekdayDepartures(stop: Stop, data: StopsFile): number {
  let n = 0
  for (const p of PERIODS) {
    const ps = data.settings.periods[p]
    if (ps.day_type !== 'weekday') {
      continue
    }
    let hours = 0
    for (let i = 0; i + 1 < ps.hours.length; i += 2) {
      hours += (ps.hours[i + 1] ?? 0) - (ps.hours[i] ?? 0)
    }
    n += periodFreq(stop, p) * hours
  }
  return n
}

function median(xs: number[]): number {
  const v = [...xs].sort((a, b) => a - b)
  const m = Math.floor(v.length / 2)
  return v.length % 2 ? (v[m] ?? 0) : ((v[m - 1] ?? 0) + (v[m] ?? 0)) / 2
}

export function scoreAll(data: StopsFile, s: Settings): Scored[] {
  const nBands = data.settings.max_walk_min / data.settings.band_min
  const bw = bandWeights(s.decay, s.walkMin, nBands, data.settings.band_min)
  const cats = data.measures.filter((m) => m.kind === 'poi').map((m) => m.id)
  const raws = data.stops.map((stop) => ({
    ...rawComponents(stop, bw, cats, s.shopJobsWeight, s.schoolWeight),
    transit: transitRaw(stop, data.settings.score.access, s.shopJobsWeight),
  }))
  function max(k: 'pop' | 'jobs' | 'dest' | 'transit'): number {
    return Math.max(1e-9, ...raws.map((r) => r[k]))
  }
  const mPop = max('pop')
  const mJobs = max('jobs')
  const mDest = max('dest')
  const mTransit = max('transit')
  const w = s.weights
  const wSum = w.pop + w.jobs + w.dest + w.transit
  const pr = data.settings.potential
  // What each stop adds: its added totals over its full ones, combined per model: in
  // trip ends (potential), or each component normalized by the largest full total (as
  // the tuned score is) with the current weights.
  const kShop = data.settings.score.shop_jobs_weight
  const kSchool = data.settings.score.school_weight
  function ov(stop: Stop, key: 'full' | 'added'): [number, number, number] {
    const o = stop.overlap?.[key] ?? {}
    return [
      o.pop ?? 0,
      o.jobs ?? 0,
      (o.poi ?? 0) + kShop * (o.shopjobs ?? 0) + kSchool * (o.school ?? 0),
    ]
  }
  const ovMax = [0, 1, 2].map((i) =>
    Math.max(1e-9, ...data.stops.map((stop) => ov(stop, 'full')[i] ?? 0)),
  )
  const rates = [pr.home_rate, pr.work_rate, pr.dest_rate]
  const ovW =
    s.model === 'potential'
      ? rates
      : [0, 1, 2].map((i) => ([w.pop, w.jobs, w.dest][i] ?? 0) / (ovMax[i] ?? 1))
  function weighted(v: [number, number, number], by: number[]): number {
    return v.reduce((acc, x, i) => acc + x * (by[i] ?? 0), 0)
  }
  function adds(stop: Stop): number | null {
    if (!stop.overlap) {
      return null
    }
    const den = weighted(ov(stop, 'full'), ovW)
    return den > 0 ? weighted(ov(stop, 'added'), ovW) / den : null
  }
  const scored = data.stops.map((stop, i) => {
    const raw = raws[i]
    const norm = {
      pop: (100 * raw.pop) / mPop,
      jobs: (100 * raw.jobs) / mJobs,
      dest: (100 * raw.dest) / mDest,
      transit: (100 * raw.transit) / mTransit,
    }
    const score =
      wSum > 0
        ? (w.pop * norm.pop + w.jobs * norm.jobs + w.dest * norm.dest + w.transit * norm.transit) /
          wSum
        : 0
    const trips = {
      pop: pr.home_rate * raw.pop,
      jobs: pr.work_rate * raw.jobs,
      dest: pr.dest_rate * raw.dest,
    }
    const potential = trips.pop + trips.jobs + trips.dest
    const deps = weekdayDepartures(stop, data)
    return {
      stop,
      raw,
      norm,
      trips,
      potential,
      score: s.model === 'potential' ? potential : score,
      perBus: deps > 0 ? potential / deps : null,
      freq: stopFreq(stop, s),
      riders: ridersRatio(stop, data.settings.fit.ratio_k),
      adds: adds(stop),
      addsTrips: stop.overlap ? weighted(ov(stop, 'added'), rates) : null,
      rank: 0,
    }
  })
  const mPerBus = median(scored.flatMap((x) => (x.perBus === null ? [] : [x.perBus])))
  for (const x of scored) {
    if (x.perBus !== null) {
      x.perBus /= Math.max(mPerBus, 1e-9)
    }
  }
  const order = [...scored].sort((a, b) => b.score - a.score)
  order.forEach((x, i) => {
    x.rank = i + 1
  })
  return scored
}
