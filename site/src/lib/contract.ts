// Shapes of the files the pipeline writes into public/data/ (pipeline/src/transit/
// export.py). Keep the two in step.

export type Period = 'peak' | 'offpeak' | 'saturday' | 'sunday'
export type DayType = 'weekday' | 'saturday' | 'sunday'
export const PERIODS: Period[] = ['peak', 'offpeak', 'saturday', 'sunday']
export const DAY_TYPES: DayType[] = ['weekday', 'saturday', 'sunday']

export interface Measure {
  id: string
  kind: 'pop' | 'jobs' | 'poi'
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
  /** All departures head one way (one side of a couplet, a terminus...). */
  one_way: boolean
  /** Smallest arc (degrees) containing every departure's heading. */
  spread_deg: number | null
  routes: string[]
  /** Trips per hour by period and route (one-way factor not applied). */
  freq: Partial<Record<Period, Record<string, number>>>
  /** Departures per hour of the service day (0-27, all routes) by day type. */
  hourly: Record<DayType, number[]>
  /** Totals per walk-time band (band i = (i, i+1] minutes), by measure id. */
  bands: Record<string, number[]>
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
    one_way_factor: number
    one_way_spread_deg: number
    cluster_max_diameter_m: number
    periods: Record<Period, PeriodSetting>
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
