import { For, type JSX, Show } from 'solid-js'

import { type Period, PERIODS } from '../lib/contract'
import { type DecayKind, DECAYS, decayWeight } from '../lib/scoring'
import {
  data,
  decay,
  oneWayFactor,
  period,
  periodWeights,
  setDecay,
  setPeriod,
  setPeriodWeights,
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

/** Tiny SVG of the decay curve over 0..walk minutes. */
function DecayCurve(): JSX.Element {
  const W = 120
  const H = 36
  function path(): string {
    const limit = walkMin()
    const pts: string[] = []
    for (let i = 0; i <= 40; i++) {
      const t = (i / 40) * limit
      const w = decayWeight(decay(), t, limit)
      pts.push(`${String((i / 40) * W)},${String(H - 2 - w * (H - 4))}`)
    }
    return `M${pts.join('L')}`
  }
  return (
    <svg class="curve" viewBox={`0 0 ${String(W)} ${String(H)}`} aria-hidden="true">
      <line x1="0" y1={H - 2} x2={W} y2={H - 2} class="axis" />
      <path d={path()} />
    </svg>
  )
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
  function categories(): string[] {
    return (data()?.measures ?? []).filter((m) => m.kind === 'poi').map((m) => m.id)
  }
  return (
    <section class="settings">
      <h2>Walk</h2>
      <Slider
        label="Walk time limit"
        value={walkMin()}
        min={5}
        max={data()?.settings.max_walk_min ?? 20}
        step={1}
        onInput={setWalkMin}
        format={(v) => `${String(v)} min`}
      />
      <div class="row">
        <label class="field">
          <span>Distance decay</span>
          <select
            value={decay().kind}
            onChange={(e) => {
              const kind = e.currentTarget.value as DecayKind
              setDecay({ kind, param: kind === 'logistic' ? 10 : 8 })
            }}
          >
            <For each={Object.entries(DECAYS)}>
              {([k, d]) => <option value={k}>{d.label}</option>}
            </For>
          </select>
        </label>
        <DecayCurve />
      </div>
      <Show when={DECAYS[decay().kind].param}>
        {(label) => (
          <Slider
            label={label()}
            value={decay().param}
            min={1}
            max={20}
            step={0.5}
            onInput={(v) => {
              setDecay({ ...decay(), param: v })
            }}
          />
        )}
      </Show>
      <p class="hint">{DECAYS[decay().kind].hint}</p>

      <h2>Score weights</h2>
      <Slider
        label="Population"
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
        label="Destinations"
        value={weights().dest}
        min={0}
        max={5}
        step={0.5}
        onInput={(v) => setWeights({ ...weights(), dest: v })}
      />
      <details class="sub">
        <summary>Destination categories</summary>
        <p class="hint">
          Each place already carries a weight by kind (a zoo counts more than a café; see About).
          These multiply whole categories.
        </p>
        <For each={categories()}>
          {(cat) => (
            <Slider
              label={cat.charAt(0).toUpperCase() + cat.slice(1)}
              value={weights().categories[cat] ?? 1}
              min={0}
              max={5}
              step={0.5}
              onInput={(v) => {
                setWeights({ ...weights(), categories: { ...weights().categories, [cat]: v } })
              }}
            />
          )}
        </For>
      </details>

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
              ? 'Average trips per hour over the periods below, weighted by the hours each stands for.'
              : `Trips per hour, ${hoursLabel(d().settings.periods[period() as Period].hours)}.`}
          </p>
        )}
      </Show>
      <p class="hint">
        Stops served in one direction only (one side of a one-way pair like Johnson/Gorham, or the
        end of a line) count their buses ×{oneWayFactor()}, since the return trip is nearby.
      </p>
      <details class="sub">
        <summary>Weighted-week period weights</summary>
        <For each={PERIODS}>
          {(p) => (
            <Slider
              label={PERIOD_LABELS[p]}
              value={periodWeights()[p]}
              min={0}
              max={100}
              step={1}
              onInput={(v) => setPeriodWeights({ ...periodWeights(), [p]: v })}
              format={(v) => `${String(v)} h`}
            />
          )}
        </For>
      </details>
    </section>
  )
}
