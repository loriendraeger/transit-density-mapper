import { useLocation, useNavigate, useSearchParams } from '@solidjs/router'
import { createEffect, createSignal, on } from 'solid-js'

import { type Period, PERIODS } from '../lib/contract'
import { GENERATORS } from '../map/colors'
import {
  data,
  defaultWeights,
  densities,
  flyTo,
  halfLife,
  model,
  period,
  selectedId,
  setDensities,
  setHalfLife,
  setModel,
  setPeriod,
  setSelectedId,
  setView,
  setWalkMin,
  setWeights,
  type View,
  walkMin,
  weights,
  weightsAreDefault,
} from './store'

// The URL mirrors the settings both ways, so a view can be shared. Hash routes (GitHub
// Pages has no SPA fallback): #/map, #/stops, #/about. Search params (defaults omitted):
//   stop=183                  selected stop (cluster id)
//   model=tuned               score tuned to today's riders (default: potential)
//   walk=5                    walk-time limit, minutes (default: pipeline [score])
//   hl=3                      half-life, minutes (default: pipeline [score])
//   w=4,0.5,5,2               weights: homes, jobs, other destinations, transit connections
//                             (default: fitted; a missing last one keeps its default)
//   period=peak|offpeak|saturday|sunday   (default: weighted aggregate)
//   density=pop,jobs,dest | none   hex layers shown (default: pop)

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
  const s = d.settings.score
  setModel(p.model === 'tuned' ? 'tuned' : 'potential')
  setWalkMin(num(p.walk, 5, d.settings.max_walk_min) ?? s.walk_min)
  setHalfLife(num(p.hl, 1, 20) ?? s.half_life_min)
  const w = defaultWeights(d)
  const [wp, wj, wd, wt] = (p.w ?? '').split(',')
  w.pop = num(wp, 0, 10) ?? w.pop
  w.jobs = num(wj, 0, 10) ?? w.jobs
  w.dest = num(wd, 0, 10) ?? w.dest
  w.transit = num(wt, 0, 10) ?? w.transit
  setWeights(w)

  setPeriod(PERIODS.includes(p.period as Period) ? (p.period as Period) : 'aggregate')
  const wanted = (p.density ?? 'pop').split(',')
  setDensities(GENERATORS.filter((g) => wanted.includes(g)))

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

function densityParam(): string | undefined {
  const d = densities()
  if (d.length === 1 && d[0] === 'pop') {
    return undefined
  }
  return d.length ? d.join(',') : 'none'
}

/** The search params for the current state (defaults left out). */
export function currentParams(): Params {
  const d = data()
  if (!d) {
    return {}
  }
  const w = weights()
  const s = d.settings.score
  return {
    stop: selectedId() ?? undefined,
    model: model() === 'potential' ? undefined : model(),
    walk: walkMin() === s.walk_min ? undefined : String(walkMin()),
    hl: halfLife() === s.half_life_min ? undefined : String(halfLife()),
    w: weightsAreDefault() ? undefined : [w.pop, w.jobs, w.dest, w.transit].map(String).join(','),
    period: period() === 'aggregate' ? undefined : period(),
    density: densityParam(),
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
