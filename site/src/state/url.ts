import { useLocation, useNavigate, useSearchParams } from '@solidjs/router'
import { createEffect, createSignal, on } from 'solid-js'

import { type Period, PERIODS } from '../lib/contract'
import { type DecayKind, DECAYS } from '../lib/scoring'
import {
  data,
  decay,
  DEFAULT_DECAY,
  DEFAULT_WALK_MIN,
  defaultPeriodWeights,
  defaultWeights,
  type Density,
  density,
  flyTo,
  oneWayFactor,
  period,
  periodWeights,
  selectedId,
  setDecay,
  setDensity,
  setOneWayFactor,
  setPeriod,
  setPeriodWeights,
  setSelectedId,
  setView,
  setWalkMin,
  setWeights,
  type View,
  walkMin,
  weights,
} from './store'

// The URL mirrors the settings both ways, so a view can be shared. Hash routes (GitHub
// Pages has no SPA fallback): #/map, #/stops, #/about. Search params (defaults omitted):
//   stop=183                  selected stop (cluster id)
//   walk=15                   walk-time limit, minutes
//   decay=linear | exponential:8 | logistic:10 | none
//   w=1,1,2                   weights: population, jobs, destinations
//   cw=food:2,parks:0         destination category weights that differ from 1
//   period=peak|offpeak|saturday|sunday   (default: weighted aggregate)
//   pw=30,50,12,12            aggregate's period weights (peak, offpeak, sat, sun)
//   owf=1.5                   one-way factor
//   density=jobs|none         density layer (default: population)

type Params = Record<string, string | undefined>

function num(s: string | undefined, lo: number, hi: number): number | null {
  if (s === undefined || s === '') {
    return null
  }
  const v = Number(s)
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null
}

function applyParams(p: Params): void {
  const d = data()
  if (!d) {
    return
  }
  setWalkMin(num(p.walk, 5, d.settings.max_walk_min) ?? DEFAULT_WALK_MIN)

  const [kind, param] = (p.decay ?? '').split(':')
  if (kind && kind in DECAYS) {
    setDecay({ kind: kind as DecayKind, param: num(param, 0.5, 30) ?? DEFAULT_DECAY.param })
  } else {
    setDecay(DEFAULT_DECAY)
  }

  const w = defaultWeights(d)
  const [wp, wj, wd] = (p.w ?? '').split(',')
  w.pop = num(wp, 0, 10) ?? w.pop
  w.jobs = num(wj, 0, 10) ?? w.jobs
  w.dest = num(wd, 0, 10) ?? w.dest
  for (const part of (p.cw ?? '').split(',')) {
    const [cat, v] = part.split(':')
    const n = num(v, 0, 10)
    if (cat && cat in w.categories && n !== null) {
      w.categories[cat] = n
    }
  }
  setWeights(w)

  setPeriod(PERIODS.includes(p.period as Period) ? (p.period as Period) : 'aggregate')
  const pw = defaultPeriodWeights(d)
  const pws = (p.pw ?? '').split(',')
  PERIODS.forEach((k, i) => {
    pw[k] = num(pws[i], 0, 1000) ?? pw[k]
  })
  setPeriodWeights(pw)
  setOneWayFactor(num(p.owf, 1, 3) ?? d.settings.one_way_factor)
  setDensity(
    (['pop', 'jobs', 'none'] as Density[]).includes(p.density as Density)
      ? (p.density as Density)
      : 'pop',
  )

  // A merged stop's id, or any of its platforms' GTFS stop ids.
  const want = p.stop
  const stop = want
    ? (d.stops.find((s) => s.id === want || s.stop_ids.includes(want))?.id ?? null)
    : null
  if (stop !== selectedId()) {
    setSelectedId(stop)
    if (stop) {
      flyTo(stop)
    }
  }
}

/** The search params for the current state (defaults left out). */
export function currentParams(): Params {
  const d = data()
  if (!d) {
    return {}
  }
  const dec = decay()
  const w = weights()
  const dw = defaultWeights(d)
  const cw = Object.entries(w.categories)
    .filter(([cat, v]) => v !== dw.categories[cat])
    .map(([cat, v]) => `${cat}:${String(v)}`)
  const pw = periodWeights()
  const dpw = defaultPeriodWeights(d)
  const pwChanged = PERIODS.some((k) => pw[k] !== dpw[k])
  const decayDefault = dec.kind === DEFAULT_DECAY.kind && dec.param === DEFAULT_DECAY.param
  return {
    stop: selectedId() ?? undefined,
    walk: walkMin() === DEFAULT_WALK_MIN ? undefined : String(walkMin()),
    decay: decayDefault
      ? undefined
      : DECAYS[dec.kind].param
        ? `${dec.kind}:${String(dec.param)}`
        : dec.kind,
    w:
      w.pop === 1 && w.jobs === 1 && w.dest === 1
        ? undefined
        : [w.pop, w.jobs, w.dest].map(String).join(','),
    cw: cw.length ? cw.join(',') : undefined,
    period: period() === 'aggregate' ? undefined : period(),
    pw: pwChanged ? PERIODS.map((k) => String(pw[k])).join(',') : undefined,
    owf: oneWayFactor() === d.settings.one_way_factor ? undefined : String(oneWayFactor()),
    density: density() === 'pop' ? undefined : density(),
  }
}

export function pathFor(v: View, overrides: Params = {}): string {
  const p = { ...currentParams(), ...overrides }
  const q = new URLSearchParams()
  for (const [k, val] of Object.entries(p)) {
    if (val !== undefined) {
      q.set(k, val)
    }
  }
  const s = q.toString()
  return `/${v}${s ? `?${s}` : ''}`
}

/** Keeps the URL and the state in step. Renders nothing. */
export function UrlSync(): null {
  const location = useLocation()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  // The URL we last wrote, so our own writes don't re-apply as if the user typed them.
  const [written, setWritten] = createSignal('')

  createEffect(() => {
    const path = location.pathname
    setView(path.startsWith('/stops') ? 'stops' : path.startsWith('/about') ? 'about' : 'map')
  })

  // URL -> state (on load and on back/forward), once the data is in.
  createEffect(
    on([() => location.search, data], ([search]) => {
      if (!data() || search === written()) {
        return
      }
      applyParams({ ...params } as Params)
    }),
  )

  // State -> URL.
  createEffect(
    on(currentParams, () => {
      if (!data()) {
        return
      }
      const target = pathFor((location.pathname.slice(1) || 'map') as View)
      const search = target.includes('?') ? target.slice(target.indexOf('?')) : ''
      if (search !== location.search) {
        setWritten(search)
        navigate(target, { replace: true, scroll: false })
      }
    }),
  )
  return null
}
