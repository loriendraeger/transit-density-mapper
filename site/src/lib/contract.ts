// Shapes of the files the pipeline writes into public/data/ (pipeline/src/transit/
// export.py). Keep the two in step.

export type Period = 'peak' | 'offpeak' | 'saturday' | 'sunday'
export type DayType = 'weekday' | 'saturday' | 'sunday'
export const PERIODS: Period[] = ['peak', 'offpeak', 'saturday', 'sunday']
export const DAY_TYPES: DayType[] = ['weekday', 'saturday', 'sunday']

export interface Measure {
  id: string
  kind: 'pop' | 'jobs' | 'shopjobs' | 'poi'
  label: string
  /** POI categories: number of places. */
  count?: number
}

export interface Route {
  id: string
  name: string
  color: string
  text_color: string
  description: string | null
  sort_order: number | null
}

export interface Stop {
  /** Cluster id: the lowest GTFS stop_id among its platforms. */
  id: string
  name: string
  codes: string[]
  stop_ids: string[]
  lon: number
  lat: number
  routes: string[]
  /** Trips per hour by period and route, averaged over the directions it runs here. */
  freq: Partial<Record<Period, Record<string, number>>>
  /** Departures per hour of the service day (0-27, all routes) by day type. */
  hourly: Record<DayType, number[]>
  /** Totals per walk-time band (band i = (i, i+1] minutes), by measure id. */
  bands: Record<string, number[]>
  /** Weekday boardings (MPO, Feb 2024) and the fitted model's expectation (fitted
   * catchment x frequency); null where the stop has no ridership figure. */
  riders: { observed: number; expected: number } | null
  /** Why the stop was left out of the fit: school, campus, park_ride, airport, transfer. */
  special: string[]
  /** What the stop adds over the next-best stop on its routes, at the default walk limit
   * and half-life: decay-weighted totals in full and added, by group (pop, jobs,
   * shopjobs, poi), and residents in reach / who'd walk 2+ minutes more without it. */
  overlap: {
    full: Partial<Record<'pop' | 'jobs' | 'shopjobs' | 'poi', number>>
    added: Partial<Record<'pop' | 'jobs' | 'shopjobs' | 'poi', number>>
    residents: number
    residents_far: number
  } | null
}

/** Fixed score settings and default weights (pipeline.toml [score], fit.py). */
export interface ScoreSettings {
  walk_min: number
  half_life_min: number
  /** Default slider weights, fit to observed boardings. */
  weights: { pop: number; jobs: number; dest: number }
  /** Other destinations = POI points + this x retail and health-care jobs. */
  shop_jobs_weight: number
  /** The walk limit, half-life and weights that predict boardings best. */
  best_fit: {
    walk_min: number
    half_life_min: number
    weights: { pop: number; jobs: number; dest: number }
    r2: number
    cv_r2: number
  }
}

/** How well the fit did (pipeline fit.py). */
export interface FitSettings {
  /** R² of log boardings per trip/h, in-sample and cross-validated. */
  r2: number
  cv_r2: number
  n_fit: number
  /** Riders vs. expected = (observed + k) / (expected + k). */
  ratio_k: number
}

export interface PeriodSetting {
  day_type: DayType
  /** [start, end) hour pairs, flattened. */
  hours: number[]
  weight: number
}

export interface Source {
  name: string
  url: string
  retrieved: string
  attribution: string
}

export interface StopsFile {
  generated: string
  feed: { start: string; end: string }
  rep_dates: Record<DayType, string>
  settings: {
    walk_speed_mps: number
    max_walk_min: number
    band_min: number
    cluster_max_diameter_m: number
    periods: Record<Period, PeriodSetting>
    score: ScoreSettings
    /** Share of destination trips by purpose group (NHTS), setting each group's total. */
    purpose_shares: Record<string, number>
    fit: FitSettings
  }
  sources: Record<string, Source>
  measures: Measure[]
  poi_kinds: { category: string; kind: string; n: number }[]
  routes: Route[]
  stops: Stop[]
}

/** The JSON index at the start of catchments.bin. */
export interface CatchmentIndex {
  version: number
  /** Coordinates are integers in 1 / scale degrees. */
  scale: number
  /** Walk times are bytes in this many seconds. */
  time_step_s: number
  /** Stop id -> [byte offset, byte length] of its record. */
  stops: Record<string, [number, number]>
}

// Tile layers (pipeline/sql/60_export/10_layers.sql).
export const WALK_LAYER = 'walk'
export const CROSSINGS_LAYER = 'crossings'
export const HEX_LAYER = 'hex'
export const HEX_PARTS_LAYER = 'hex_parts'
export const POIS_LAYER = 'pois'
export const PLATFORMS_LAYER = 'platforms'
export const ROUTES_LAYER = 'routes'
