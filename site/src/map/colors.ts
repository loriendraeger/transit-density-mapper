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
//   riders vs.     diverging red (fewer riders than expected) <-> gray <-> blue (more),
//   expected       3 steps per arm. Blue/red is the colorblind-safe diverging axis; it
//                  shares blue with population, but stops are outlined circles above
//                  the hexes, and the score's orange isn't shown at the same time.

/** Stop score ramp, low -> high. Dark mode: low recedes into the dark surface. */
export const SCORE_RAMP: Record<Mode, string[]> = {
  light: ['#f0946a', '#eb6834', '#cf5223', '#a83e17', '#7a2c0f'],
  dark: ['#933d18', '#b84a1b', '#d95926', '#ec835a', '#f4ac8a'],
}

export type Generator = 'pop' | 'jobs' | 'dest'
/** Map order: halves and thirds of a hex go to the selected generators in this order. */
export const GENERATORS: Generator[] = ['pop', 'jobs', 'dest']

export const GENERATOR_LABELS: Record<Generator, { label: string; unit: string }> = {
  pop: { label: 'Homes', unit: 'Residents per km²' },
  jobs: { label: 'Jobs', unit: 'Jobs per km²' },
  dest: {
    label: 'Other destinations',
    unit: 'Destination points per km² (places weighted by trip purpose; shops and clinics by jobs)',
  },
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

/** Riders vs. expected, fewer -> more: 3 red steps, gray (about as expected), 3 blue. */
export const RIDERS_RAMP: Record<Mode, string[]> = {
  light: ['#9a2929', '#d74745', '#ed8c84', '#b4b3ab', '#86b6ef', '#3987e5', '#1c5cab'],
  dark: ['#eb827b', '#c04442', '#8c2d2b', '#5f5e59', '#184f95', '#256abf', '#5598e7'],
}
/** Ratio breaks (observed / expected): x1/4, x1/2, x0.8 | x1.25, x2, x4. */
export const RIDERS_BREAKS = [0.25, 0.5, 0.8, 1.25, 2, 4]

/** "What it adds" breaks (share of the catchment no other stop on its routes serves as
 * well; median stop ~9 %), on the score ramp. */
export const ADDS_BREAKS = [0.05, 0.1, 0.2, 0.4]

/** Transit reach of the selected stop, near -> far (<= 15, 30, 45, 60 min by transit):
 * one saturated magenta (a hue used nowhere else on the map), strongest nearest, in even
 * lightness steps (OKLCH L ~0.43 -> 0.91 light, 0.88 -> 0.39 dark). The farthest class
 * deliberately fades toward the background (owner's tuning, 2026-10-22): it's below the
 * dataviz validator's 2:1 contrast floor for discrete classes (1.3:1 light, 1.7:1 dark),
 * so the reach reads as fading out at its edge; the other checks pass. */
export const TRANSIT_REACH_RAMP: Record<Mode, string[]> = {
  light: ['#8f0067', '#d0399c', '#ec9bcc', '#ffd3ec'],
  dark: ['#ffbae8', '#f46cbf', '#b8338a', '#721f55'],
}
export const TRANSIT_REACH_BREAKS = [15, 30, 45]

/** Class breaks for the score ramp (0-100). */
export const SCORE_BREAKS = [20, 40, 60, 80]

/** Density breaks per km2 (destinations: roughly the 60th-95th percentile of hexes,
 * points plus shop and clinic jobs at the fitted rate; 2026-10-21). */
export const DENSITY_BREAKS: Record<Generator, number[]> = {
  pop: [1000, 2500, 5000, 10000],
  jobs: [1000, 3000, 10000, 30000],
  dest: [10, 30, 100, 250],
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

/** Frequency breaks (trips per hour per direction: hourly, 30, 15, 7.5 min service). */
export const FREQ_BREAKS = [1, 2, 4, 8]

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
