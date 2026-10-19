import * as Plot from '@observablehq/plot'
import { createEffect, type JSX, onCleanup } from 'solid-js'

import { MODE } from '../map/colors'

// Departures per hour for one stop and day type: one series, so no legend (the heading
// names it). Columns with a 4px rounded top, a hover tip per column.

const BAR = { light: '#2a78d6', dark: '#3987e5' }

function hourLabel(h: number): string {
  const hh = h % 24
  if (hh === 0) {
    return '12a'
  }
  if (hh === 12) {
    return '12p'
  }
  return hh < 12 ? `${String(hh)}a` : `${String(hh - 12)}p`
}

export default function HourlyChart(props: { counts: number[]; width?: number }): JSX.Element {
  let el: HTMLDivElement | undefined
  createEffect(() => {
    if (!el) {
      return
    }
    // Trim to the service span (first to last hour with a departure), at least 5am-midnight.
    const counts = props.counts
    const firstService = counts.findIndex((c) => c > 0)
    const first = firstService === -1 ? 5 : Math.min(5, firstService)
    let last = 24
    counts.forEach((c, i) => {
      if (c > 0) {
        last = Math.max(last, i + 1)
      }
    })
    const rows = counts.slice(first, last).map((n, i) => ({ hour: first + i, n }))
    const chart = Plot.plot({
      width: props.width ?? el.clientWidth,
      height: 140,
      marginLeft: 28,
      marginBottom: 24,
      style: { background: 'transparent', fontSize: '11px' },
      x: {
        type: 'band',
        label: null,
        tickFormat: (h: number) => (h % 3 === 0 ? hourLabel(h) : ''),
        tickSize: 0,
        padding: 0.15,
      },
      y: { label: null, grid: true, ticks: 4, tickFormat: 'd' },
      marks: [
        Plot.barY(rows, {
          x: 'hour',
          y: 'n',
          fill: BAR[MODE],
          // Rounded data end (the top), square at the baseline.
          ry2: 4,
        }),
        Plot.ruleY([0]),
        Plot.tip(
          rows,
          Plot.pointerX({
            x: 'hour',
            y: 'n',
            title: (d: { hour: number; n: number }) =>
              `${hourLabel(d.hour)}–${hourLabel(d.hour + 1)}: ${String(d.n)} departures`,
          }),
        ),
      ],
    })
    el.replaceChildren(chart)
  })
  onCleanup(() => el?.replaceChildren())
  return (
    <div
      class="chart"
      ref={(e) => {
        el = e
      }}
    />
  )
}
