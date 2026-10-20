import { type Flavor, namedFlavor } from '@protomaps/basemaps'
import type { ExpressionSpecification } from 'maplibre-gl'

export type Mode = 'light' | 'dark'

export const MODE: Mode = window.matchMedia('(prefers-color-scheme: dark)').matches
  ? 'dark'
  : 'light'

// Color jobs on the map (ramps checked with the dataviz validator, light and dark):
//   stop score     orange ordinal ramp (5 steps), the map's subject
//   density        one sequential ramp per generator, under everything (lightest steps
//                  recede into the surface by design): population blue, jobs green,
//                  destinations yellow (owner's picks)
//   catchment      violet (categorical slot 7): blob and spiderweb of the selected stop

/** Stop score ramp, low -> high. Dark mode: low recedes into the dark surface. */
export const SCORE_RAMP: Record<Mode, string[]> = {
  light: ['#f0946a', '#eb6834', '#cf5223', '#a83e17', '#7a2c0f'],
  dark: ['#933d18', '#b84a1b', '#d95926', '#ec835a', '#f4ac8a'],
}

export type Generator = 'pop' | 'jobs' | 'dest'
/** Map order: halves and thirds of a hex go to the selected generators in this order. */
export const GENERATORS: Generator[] = ['pop', 'jobs', 'dest']

export const GENERATOR_LABELS: Record<Generator, { label: string; unit: string }> = {
  pop: { label: 'Population', unit: 'Residents per km²' },
  jobs: { label: 'Jobs', unit: 'Jobs per km²' },
  dest: { label: 'Destinations', unit: 'Destination points per km² (food, venues, parks...)' },
}

/** Density ramps, low -> high; dark mode runs from the surface up. */
export const DENSITY_RAMPS: Record<Generator, Record<Mode, string[]>> = {
  pop: {
    light: ['#cde2fb', '#86b6ef', '#3987e5', '#1c5cab', '#0d366b'],
    dark: ['#0d366b', '#184f95', '#256abf', '#5598e7', '#9ec5f4'],
  },
  jobs: {
    light: ['#cdeccd', '#8fd18f', '#43ad43', '#1d7f1d', '#0b520b'],
    dark: ['#0b520b', '#1d7f1d', '#2f9a2f', '#5cc05c', '#9fdd9f'],
  },
  dest: {
    light: ['#fbefc0', '#f5d572', '#eaa800', '#b07800', '#6e4a00'],
    dark: ['#5c3e00', '#8a5e00', '#c48a00', '#eab02a', '#f7d77a'],
  },
}

export const CATCHMENT: Record<Mode, string> = { light: '#6250d6', dark: '#9085e9' }

export const SURFACE: Record<Mode, string> = { light: '#fcfcfb', dark: '#1a1a19' }
export const INK_2: Record<Mode, string> = { light: '#52514e', dark: '#c3c2b7' }

/** Class breaks for the score ramp (0-100). */
export const SCORE_BREAKS = [20, 40, 60, 80]

/** Density breaks per km2 (destinations: roughly the 60th-95th percentile of hexes). */
export const DENSITY_BREAKS: Record<Generator, number[]> = {
  pop: [1000, 2500, 5000, 10000],
  jobs: [1000, 3000, 10000, 30000],
  dest: [20, 50, 100, 200],
}

/** Hex attribute holding each generator's density (destinations are summed from
 * per-category d_<category> attributes instead; see MapView densityValue). */
export const DENSITY_FIELD: Record<Exclude<Generator, 'dest'>, string> = {
  pop: 'pop_km2',
  jobs: 'jobs_km2',
}

export function stepExpr(
  input: ExpressionSpecification,
  ramp: string[],
  breaks: readonly number[],
): ExpressionSpecification {
  const stops = breaks.flatMap((b, i) => [b, ramp[i + 1]])
  return ['step', input, ramp[0], ...stops] as ExpressionSpecification
}

/** Frequency breaks (trips per hour) when stops are colored by frequency. */
export const FREQ_BREAKS = [2, 4, 8, 15]

/**
 * The Protomaps flavor with its greens (parks, woods, scrub, the zoo, green landcover,
 * green POI icons) turned into the plain land color, so green on the map only ever
 * means jobs. A style change only: the basemap tiles stay as they are.
 */
export function neutralFlavor(mode: Mode): Flavor {
  const f = namedFlavor(mode)
  const land = f.earth
  return {
    ...f,
    park_a: land,
    park_b: land,
    wood_a: land,
    wood_b: land,
    scrub_a: land,
    scrub_b: land,
    zoo: land,
    ...(f.landcover
      ? {
          landcover: {
            ...f.landcover,
            forest: land,
            grassland: land,
            farmland: land,
            scrub: land,
          },
        }
      : {}),
    ...(f.pois ? { pois: { ...f.pois, green: f.pois.slategray } } : {}),
  }
}
