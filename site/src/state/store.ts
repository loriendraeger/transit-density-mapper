import { createMemo, createRoot, createSignal } from 'solid-js'

import type { Period, StopsFile } from '../lib/contract'
import {
  type Decay,
  type Model,
  scoreAll,
  type Scored,
  type Settings,
  type Weights,
} from '../lib/scoring'
import type { Generator } from '../map/colors'

// App state as Solid signals. The map subscribes and updates sources/paint in place.

export type View = 'map' | 'stops' | 'about'
export const [view, setView] = createSignal<View>('map')

export const [data, setData] = createSignal<StopsFile | null>(null)
export const [loadError, setLoadError] = createSignal<string | null>(null)

// --- scoring settings ---------------------------------------------------------------
// Two score models (lib/scoring.ts): potential (the default; trip ends a day by all
// modes, fixed rates) and tuned to today's riders (weights fit to boardings). Both use
// the walk limit and half-life. In tuned mode the user sets the weights too, directly or
// from two presets: the default assumption (pipeline.toml [score], weights fit to
// ridership there) and the best fit (the walk/half-life that predict ridership best).
// All in the URL (url.ts). Period weights are fixed.

export const [model, setModel] = createSignal<Model>('potential')

export const [walkMin, setWalkMin] = createSignal(10)
export const [halfLife, setHalfLife] = createSignal(4)

/** Distance decay: exponential with the chosen half-life. */
export function decay(): Decay {
  return { kind: 'exponential', param: halfLife() }
}

export type PresetName = 'default' | 'best'
export interface Preset {
  walkMin: number
  halfLife: number
  weights: Weights
}

export function preset(d: StopsFile, name: PresetName): Preset {
  const s = d.settings.score
  return name === 'default'
    ? { walkMin: s.walk_min, halfLife: s.half_life_min, weights: { ...s.weights } }
    : {
        walkMin: s.best_fit.walk_min,
        halfLife: s.best_fit.half_life_min,
        weights: { ...s.best_fit.weights },
      }
}

export function applyPreset(name: PresetName): void {
  const d = data()
  if (!d) {
    return
  }
  const p = preset(d, name)
  setWalkMin(p.walkMin)
  setHalfLife(p.halfLife)
  setWeights(p.weights)
}

/** The preset the current walk limit, half-life and weights match, if any. */
export function activePreset(): PresetName | null {
  const d = data()
  if (!d) {
    return null
  }
  const w = weights()
  for (const name of ['default', 'best'] as const) {
    const p = preset(d, name)
    if (
      p.walkMin === walkMin() &&
      p.halfLife === halfLife() &&
      p.weights.pop === w.pop &&
      p.weights.jobs === w.jobs &&
      p.weights.dest === w.dest &&
      p.weights.transit === w.transit
    ) {
      return name
    }
  }
  return null
}

/** Weighted-week period weights (fixed: hours per week each period stands for). */
export function periodWeights(): Record<Period, number> {
  const p = data()?.settings.periods
  return {
    peak: p?.peak.weight ?? 30,
    offpeak: p?.offpeak.weight ?? 50,
    saturday: p?.saturday.weight ?? 12,
    sunday: p?.sunday.weight ?? 12,
  }
}

/** Default weights: fit to observed boardings by the pipeline. */
export function defaultWeights(d: StopsFile): Weights {
  return { ...d.settings.score.weights }
}

export const [weights, setWeights] = createSignal<Weights>({
  pop: 1,
  jobs: 1,
  dest: 1,
  transit: 1,
})
export const [period, setPeriod] = createSignal<Period | 'aggregate'>('aggregate')

/** Whether the weights are the defaults. */
export function weightsAreDefault(): boolean {
  const d = data()
  const w = weights()
  if (!d) {
    return true
  }
  const dw = d.settings.score.weights
  return w.pop === dw.pop && w.jobs === dw.jobs && w.dest === dw.dest && w.transit === dw.transit
}

/** Called once stops.json arrives, before the URL is applied. */
export function initFromData(d: StopsFile): void {
  const p = preset(d, 'default')
  setWalkMin(p.walkMin)
  setHalfLife(p.halfLife)
  setWeights(p.weights)
  setData(d)
}

export const settings = createRoot(() =>
  createMemo((): Settings => ({
    model: model(),
    walkMin: walkMin(),
    decay: decay(),
    weights: weights(),
    period: period(),
    periodWeights: periodWeights(),
    shopJobsWeight: data()?.settings.score.shop_jobs_weight ?? 0,
    schoolWeight: data()?.settings.score.school_weight ?? 0,
  })),
)

/** Every stop scored at the current settings. */
export const scored = createRoot(() =>
  createMemo((): Scored[] => {
    const d = data()
    return d ? scoreAll(d, settings()) : []
  }),
)

export const scoredById = createRoot(() =>
  createMemo(() => new Map(scored().map((s) => [s.stop.id, s]))),
)

// --- selection & map display -------------------------------------------------------

export const [selectedId, setSelectedId] = createSignal<string | null>(null)
export const selected = createRoot(() =>
  createMemo(() => {
    const id = selectedId()
    return id === null ? null : (scoredById().get(id) ?? null)
  }),
)

/** Which trip generators the hex layer shows (one hex piece each when several). */
export const [densities, setDensities] = createSignal<Generator[]>(['pop'])
export const [densityOpacity, setDensityOpacity] = createSignal(0.35)
export const [showPois, setShowPois] = createSignal(false)
export const [showSpiderweb, setShowSpiderweb] = createSignal(true)
/** The selected stop's transit isochrone (hexes by travel time by transit). */
export const [showTransitReach, setShowTransitReach] = createSignal(false)
/** The isochrone is on screen (layer on and a stop selected): the trip-generator hexes
 * are hidden meanwhile, so the two don't mix. */
export function transitReachActive(): boolean {
  return showTransitReach() && selectedId() !== null
}
export const [showCrossings, setShowCrossings] = createSignal(false)
export const [showRoutes, setShowRoutes] = createSignal(true)
export const [blobOpacity, setBlobOpacity] = createSignal(0.5)
/** What stop circles are colored by. */
export type StopColor = 'score' | 'freq' | 'transit' | 'riders' | 'adds' | 'perbus'
export const [stopColor, setStopColor] = createSignal<StopColor>('score')

/** Ask the map to fly to a stop (from the table or the URL). */
export const [flyRequest, setFlyRequest] = createSignal<{ id: string; n: number } | null>(null)
let flyN = 0
export function flyTo(id: string): void {
  flyN += 1
  setFlyRequest({ id, n: flyN })
}
