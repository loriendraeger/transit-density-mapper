import { For, type JSX, Show } from 'solid-js'

import { type Period, PERIODS } from '../lib/contract'
import {
  data,
  defaultWeights,
  period,
  periodWeights,
  setPeriod,
  setWeights,
  weights,
  weightsAreDefault,
} from '../state/store'

export const PERIOD_LABELS: Record<Period | 'aggregate', string> = {
  aggregate: 'Weighted week',
  peak: 'Weekday peak',
  offpeak: 'Weekday off-peak',
  saturday: 'Saturday',
  sunday: 'Sunday',
}

export function hoursLabel(hours: number[]): string {
  const parts: string[] = []
  for (let i = 0; i + 1 < hours.length; i += 2) {
    parts.push(`${clock(hours[i])}–${clock(hours[i + 1])}`)
  }
  return parts.join(', ')
}

function clock(h: number): string {
  const hh = h % 24
  const suffix = hh < 12 ? 'am' : 'pm'
  const twelve = hh % 12 === 0 ? 12 : hh % 12
  return `${String(twelve)}${suffix}`
}

function resetWeights(): void {
  const d = data()
  if (d) {
    setWeights(defaultWeights(d))
  }
}

function Slider(props: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onInput: (v: number) => void
  format?: (v: number) => string
}): JSX.Element {
  return (
    <label class="slider">
      <span class="slider-label">
        {props.label}
        <output>{props.format ? props.format(props.value) : String(props.value)}</output>
      </span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onInput={(e) => {
          props.onInput(Number(e.currentTarget.value))
        }}
      />
    </label>
  )
}

export default function Settings(): JSX.Element {
  return (
    <section class="settings">
      <h2>Score weights</h2>
      <Slider
        label="Homes"
        value={weights().pop}
        min={0}
        max={5}
        step={0.5}
        onInput={(v) => setWeights({ ...weights(), pop: v })}
      />
      <Slider
        label="Jobs"
        value={weights().jobs}
        min={0}
        max={5}
        step={0.5}
        onInput={(v) => setWeights({ ...weights(), jobs: v })}
      />
      <Slider
        label="Other destinations"
        value={weights().dest}
        min={0}
        max={5}
        step={0.5}
        onInput={(v) => setWeights({ ...weights(), dest: v })}
      />
      <Show when={data()}>
        {(d) => (
          <p class="hint">
            <Show
              when={weightsAreDefault()}
              fallback={
                <>
                  <button type="button" class="link" onClick={resetWeights}>
                    Reset to the fitted defaults
                  </button>
                  .
                </>
              }
            >
              Defaults fit to weekday boardings (see About).
            </Show>{' '}
            Everything within a {d().settings.score.walk_min}-minute walk counts, halving every{' '}
            {d().settings.score.half_life_min} minutes.
          </p>
        )}
      </Show>

      <h2>Frequency</h2>
      <label class="field">
        <span>Service period</span>
        <select
          value={period()}
          onChange={(e) => {
            setPeriod(e.currentTarget.value as Period | 'aggregate')
          }}
        >
          <For each={['aggregate', ...PERIODS] as (Period | 'aggregate')[]}>
            {(p) => <option value={p}>{PERIOD_LABELS[p]}</option>}
          </For>
        </select>
      </label>
      <Show when={data()}>
        {(d) => (
          <p class="hint">
            {period() === 'aggregate'
              ? `Average trips per hour over the week, each period weighted by the hours it stands for (${PERIODS.map((p) => `${PERIOD_LABELS[p].toLowerCase()} ${String(periodWeights()[p])} h`).join(', ')}).`
              : `Trips per hour, ${hoursLabel(d().settings.periods[period() as Period].hours)}.`}{' '}
            Per direction: each route counts the average of its directions at the stop, then routes
            add up.
          </p>
        )}
      </Show>
    </section>
  )
}
