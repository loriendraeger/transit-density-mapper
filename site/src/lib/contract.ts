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

/** One stop's walkshed, from catchments.json (all stops, keyed by stop id). */
export interface CatchmentFile {
  /** Spiderweb: walk-network edge ids (delta-encoded, ascending) and walk times (s). */
  edges: { id_deltas: number[]; t: number[] }
  /** Blob: band i (cumulative, walk time <= (i + 1) minutes) as polygons of rings; each
   * ring is [x0, y0, dx1, dy1, ...] in integer 1e-5 degrees. */
  bands: number[][][][]
}

export type CatchmentsFile = Record<string, CatchmentFile>

// Tile layers (pipeline/sql/60_export/10_layers.sql).
export const WALK_LAYER = 'walk'
export const CROSSINGS_LAYER = 'crossings'
export const HEX_LAYER = 'hex'
export const POIS_LAYER = 'pois'
export const PLATFORMS_LAYER = 'platforms'
