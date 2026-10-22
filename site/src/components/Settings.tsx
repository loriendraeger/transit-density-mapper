import { For, type JSX, Show } from 'solid-js'

import { type Period, PERIODS } from '../lib/contract'
import {
  activePreset,
  applyPreset,
  data,
  halfLife,
  period,
  periodWeights,
  setHalfLife,
  setPeriod,
  setWalkMin,
  setWeights,
  walkMin,
  weights,
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
      <h2>Walk</h2>
      <Show when={data()}>
        {(d) => (
          <>
            <div class="segmented presets" role="radiogroup" aria-label="Walk and weight preset">
              <button
                role="radio"
                aria-checked={activePreset() === 'default'}
                onClick={() => {
                  applyPreset('default')
                }}
              >
                Default assumption
              </button>
              <button
                role="radio"
                aria-checked={activePreset() === 'best'}
                onClick={() => {
                  applyPreset('best')
                }}
              >
                Best fit
              </button>
            </div>
            <p class="hint">
              Default assumption: the usual {d().settings.score.walk_min}-minute planning walk,
              weight halving every {d().settings.score.half_life_min} minutes. Best fit: the walk
              that predicts boardings best ({d().settings.score.best_fit.walk_min} minutes, halving
              every {d().settings.score.best_fit.half_life_min}); it explains{' '}
              {Math.round(d().settings.score.best_fit.cv_r2 * 100)} % of the variation in boardings
              per trip, against {Math.round(d().settings.fit.cv_r2 * 100)} %. Each sets the weights
              fit for it.
            </p>
          </>
        )}
      </Show>
      <Slider
        label="Walk time limit"
        value={walkMin()}
        min={5}
        max={data()?.settings.max_walk_min ?? 20}
        step={1}
        onInput={setWalkMin}
        format={(v) => `${String(v)} min`}
      />
      <Slider
        label="Half-life"
        value={halfLife()}
        min={1}
        max={20}
        step={0.5}
        onInput={setHalfLife}
        format={(v) => `${String(v)} min`}
      />

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
      <Slider
        label="Transit connections"
        value={weights().transit}
        min={0}
        max={5}
        step={0.5}
        onInput={(v) => setWeights({ ...weights(), transit: v })}
      />
      <p class="hint">
        Homes, jobs and other destinations count what's within walking distance; transit connections
        count the jobs and destinations reachable by riding from the stop.
      </p>

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
