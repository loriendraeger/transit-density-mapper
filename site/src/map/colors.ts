import type { ExpressionSpecification } from 'maplibre-gl'

export type Mode = 'light' | 'dark'

export const MODE: Mode = window.matchMedia('(prefers-color-scheme: dark)').matches
  ? 'dark'
  : 'light'

// Three color jobs on one map, so three hues that don't compete (all validated with the
// dataviz validator, light and dark):
//   stop score     orange ordinal ramp (5 steps), the map's subject
//   density        blue sequential ramp under everything (lightest recedes)
//   catchment      violet (categorical slot 7): blob and spiderweb of the selected stop

/** Stop score ramp, low -> high. Dark mode: low recedes into the dark surface. */
export const SCORE_RAMP: Record<Mode, string[]> = {
  light: ['#f0946a', '#eb6834', '#cf5223', '#a83e17', '#7a2c0f'],
  dark: ['#933d18', '#b84a1b', '#d95926', '#ec835a', '#f4ac8a'],
}

/** Density ramp (blue 100 -> 700), low -> high; dark mode runs from the surface up. */
export const DENSITY_RAMP: Record<Mode, string[]> = {
  light: ['#cde2fb', '#86b6ef', '#3987e5', '#1c5cab', '#0d366b'],
  dark: ['#0d366b', '#184f95', '#256abf', '#5598e7', '#9ec5f4'],
}

export const CATCHMENT: Record<Mode, string> = { light: '#6250d6', dark: '#9085e9' }

export const SURFACE: Record<Mode, string> = { light: '#fcfcfb', dark: '#1a1a19' }
export const INK_2: Record<Mode, string> = { light: '#52514e', dark: '#c3c2b7' }

/** Class breaks for the score ramp (0-100). */
export const SCORE_BREAKS = [20, 40, 60, 80]

/** Density breaks, people or jobs per km2. */
export const DENSITY_BREAKS = {
  pop: [1000, 2500, 5000, 10000],
  jobs: [1000, 3000, 10000, 30000],
} as const

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
