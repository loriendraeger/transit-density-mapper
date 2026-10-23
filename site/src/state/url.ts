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
  mapView,
  model,
  parseView,
  period,
  selectedId,
  setDensities,
  setHalfLife,
  setModel,
  setPeriod,
  setSelectedId,
  setShowTransitReach,
  setStopColor,
  setView,
  setViewRequest,
  setWalkMin,
  setWeights,
  showTransitReach,
  type StopColor,
  stopColor,
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
//   color=freq|perbus|transit|riders|adds   what stops are colored by (default: score)
//   reach=1                   the selected stop's transit reach layer on
//   view=14.5/43.07541/-89.40410   map zoom/lat/lon (written as the map moves; a link
//                             with it opens there instead of framing the selected stop)

type Params = Record<string, string | undefined>

const STOP_COLORS: StopColor[] = ['score', 'freq', 'perbus', 'transit', 'riders', 'adds']

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
  setStopColor(STOP_COLORS.includes(p.color as StopColor) ? (p.color as StopColor) : 'score')
  setShowTransitReach(p.reach === '1')
  const wanted = (p.density ?? 'pop').split(',')
  setDensities(GENERATORS.filter((g) => wanted.includes(g)))

  // A merged stop's id, or any of its platforms' GTFS stop ids.
  const want = p.stop
  const stop = want
    ? (d.stops.find((s) => s.id === want || s.stop_ids.includes(want))?.id ?? null)
    : null
  const view = parseView(p.view)
  if (view && p.view !== mapView()) {
    setViewRequest(view)
  }
  if (stop !== selectedId()) {
    setSelectedId(stop)
    if (stop && !view) {
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
    color: stopColor() === 'score' ? undefined : stopColor(),
    reach: showTransitReach() ? '1' : undefined,
    view: mapView() ?? undefined,
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
  // '/' and ',' are legal in a query; unescaped, view=14.5/43.07/-89.4 stays readable.
  const s = q.toString().replaceAll('%2F', '/').replaceAll('%2C', ',')
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
