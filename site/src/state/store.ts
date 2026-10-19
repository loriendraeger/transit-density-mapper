import { createMemo, createRoot, createSignal } from 'solid-js'

import type { Period, StopsFile } from '../lib/contract'
import { type Decay, scoreAll, type Scored, type Settings, type Weights } from '../lib/scoring'

// App state as Solid signals. The map subscribes and updates sources/paint in place.

export type View = 'map' | 'stops' | 'about'
export const [view, setView] = createSignal<View>('map')

export const [data, setData] = createSignal<StopsFile | null>(null)
export const [loadError, setLoadError] = createSignal<string | null>(null)

// --- scoring settings (all in the URL; see url.ts) ---------------------------------

export const DEFAULT_WALK_MIN = 10
export const DEFAULT_DECAY: Decay = { kind: 'exponential', param: 8 }

export const [walkMin, setWalkMin] = createSignal(DEFAULT_WALK_MIN)
export const [decay, setDecay] = createSignal<Decay>(DEFAULT_DECAY)
export const [weights, setWeights] = createSignal<Weights>({
  pop: 1,
  jobs: 1,
  dest: 1,
  categories: {},
})
export const [period, setPeriod] = createSignal<Period | 'aggregate'>('aggregate')
export const [oneWayFactor, setOneWayFactor] = createSignal(2)
export const [periodWeights, setPeriodWeights] = createSignal<Record<Period, number>>({
  peak: 30,
  offpeak: 50,
  saturday: 12,
  sunday: 12,
})

/** Defaults that come from the data (category list, pipeline settings). */
export function defaultWeights(d: StopsFile): Weights {
  const categories: Record<string, number> = {}
  for (const m of d.measures) {
    if (m.kind === 'poi') {
      categories[m.id] = 1
    }
  }
  return { pop: 1, jobs: 1, dest: 1, categories }
}

export function defaultPeriodWeights(d: StopsFile): Record<Period, number> {
  const p = d.settings.periods
  return {
    peak: p.peak.weight,
    offpeak: p.offpeak.weight,
    saturday: p.saturday.weight,
    sunday: p.sunday.weight,
  }
}

/** Called once stops.json arrives, before the URL is applied. */
export function initFromData(d: StopsFile): void {
  setWeights(defaultWeights(d))
  setPeriodWeights(defaultPeriodWeights(d))
  setOneWayFactor(d.settings.one_way_factor)
  setData(d)
}

export const settings = createRoot(() =>
  createMemo((): Settings => ({
    walkMin: walkMin(),
    decay: decay(),
    weights: weights(),
    period: period(),
    oneWayFactor: oneWayFactor(),
    periodWeights: periodWeights(),
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

export type Density = 'pop' | 'jobs' | 'none'
export const [density, setDensity] = createSignal<Density>('pop')
export const [densityOpacity, setDensityOpacity] = createSignal(0.45)
export const [showPois, setShowPois] = createSignal(false)
export const [showSpiderweb, setShowSpiderweb] = createSignal(true)
export const [showCrossings, setShowCrossings] = createSignal(false)
export const [blobOpacity, setBlobOpacity] = createSignal(0.5)
/** What stop circles are colored by. */
export type StopColor = 'score' | 'freq'
export const [stopColor, setStopColor] = createSignal<StopColor>('score')

/** Ask the map to fly to a stop (from the table or the URL). */
export const [flyRequest, setFlyRequest] = createSignal<{ id: string; n: number } | null>(null)
let flyN = 0
export function flyTo(id: string): void {
  flyN += 1
  setFlyRequest({ id, n: flyN })
}
