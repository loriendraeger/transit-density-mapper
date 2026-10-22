import { createMemo, createRoot, createSignal } from 'solid-js'

import type { Period, StopsFile } from '../lib/contract'
import { type Decay, scoreAll, type Scored, type Settings, type Weights } from '../lib/scoring'
import type { Generator } from '../map/colors'

// App state as Solid signals. The map subscribes and updates sources/paint in place.

export type View = 'map' | 'stops' | 'about'
export const [view, setView] = createSignal<View>('map')

export const [data, setData] = createSignal<StopsFile | null>(null)
export const [loadError, setLoadError] = createSignal<string | null>(null)

// --- scoring settings ---------------------------------------------------------------
// Fixed by the pipeline (pipeline.toml [score]; owner 2026-10-21): walk limit, decay
// and period weights. The user picks the weights (in the URL; see url.ts) and period.

/** Walk-time limit, minutes (fixed). */
export function walkMin(): number {
  return data()?.settings.score.walk_min ?? 10
}

/** Distance decay (fixed): exponential with the configured half-life. */
export function decay(): Decay {
  return { kind: 'exponential', param: data()?.settings.score.half_life_min ?? 4 }
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

export const [weights, setWeights] = createSignal<Weights>({ pop: 1, jobs: 1, dest: 1 })
export const [period, setPeriod] = createSignal<Period | 'aggregate'>('aggregate')

/** Whether the weights are the defaults. */
export function weightsAreDefault(): boolean {
  const d = data()
  const w = weights()
  if (!d) {
    return true
  }
  const dw = d.settings.score.weights
  return w.pop === dw.pop && w.jobs === dw.jobs && w.dest === dw.dest
}

/** Called once stops.json arrives, before the URL is applied. */
export function initFromData(d: StopsFile): void {
  setWeights(defaultWeights(d))
  setData(d)
}

export const settings = createRoot(() =>
  createMemo((): Settings => ({
    walkMin: walkMin(),
    decay: decay(),
    weights: weights(),
    period: period(),
    periodWeights: periodWeights(),
    shopJobsWeight: data()?.settings.score.shop_jobs_weight ?? 0,
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
export const [densityOpacity, setDensityOpacity] = createSignal(0.45)
export const [showPois, setShowPois] = createSignal(false)
export const [showSpiderweb, setShowSpiderweb] = createSignal(true)
export const [showCrossings, setShowCrossings] = createSignal(false)
export const [showRoutes, setShowRoutes] = createSignal(true)
export const [blobOpacity, setBlobOpacity] = createSignal(0.5)
/** What stop circles are colored by. */
export type StopColor = 'score' | 'freq' | 'riders'
export const [stopColor, setStopColor] = createSignal<StopColor>('score')

/** Ask the map to fly to a stop (from the table or the URL). */
export const [flyRequest, setFlyRequest] = createSignal<{ id: string; n: number } | null>(null)
let flyN = 0
export function flyTo(id: string): void {
  flyN += 1
  setFlyRequest({ id, n: flyN })
}
