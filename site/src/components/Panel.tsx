import { useNavigate } from '@solidjs/router'
import { For, type JSX, Show } from 'solid-js'

import {
  ADDS_BREAKS,
  DENSITY_BREAKS,
  DENSITY_RAMPS,
  FREQ_BREAKS,
  GENERATOR_LABELS,
  GENERATORS,
  MODE,
  PERBUS_BREAKS,
  PERBUS_RAMP,
  POTENTIAL_BREAKS,
  RIDERS_BREAKS,
  RIDERS_RAMP,
  SCORE_BREAKS,
  SCORE_RAMP,
  TRANSIT_REACH_BREAKS,
  TRANSIT_REACH_RAMP,
} from '../map/colors'
import {
  blobOpacity,
  data,
  densities,
  densityOpacity,
  loadError,
  model,
  selected,
  setBlobOpacity,
  setDensities,
  setDensityOpacity,
  setSelectedId,
  setShowCrossings,
  setShowPois,
  setShowRoutes,
  setShowSpiderweb,
  setShowTransitReach,
  setStopColor,
  showCrossings,
  showPois,
  showRoutes,
  showSpiderweb,
  showTransitReach,
  type StopColor,
  stopColor,
  transitReachActive,
} from '../state/store'
import { pathFor } from '../state/url'
import Settings from './Settings'
import StopDetail from './StopDetail'

function Legend(props: {
  ramp: string[]
  breaks: readonly number[]
  unit: string
  format?: (v: number) => string
  /** Upper bound of the last class, if it has one (else it reads "b+"). */
  max?: number
}): JSX.Element {
  function f(v: number): string {
    return props.format ? props.format(v) : v.toLocaleString('en-US')
  }
  // ramp has one more class than breaks: < b0, b0-b1, ..., >= b_last.
  function labels(): string[] {
    const b = props.breaks
    return [...props.ramp.keys()].map((i) => {
      const lo = b.at(i - 1)
      const hi = b.at(i)
      if (i === 0 && hi !== undefined) {
        return `< ${f(hi)}`
      }
      if (lo === undefined) {
        return ''
      }
      if (hi === undefined) {
        return props.max === undefined ? `${f(lo)}+` : `${f(lo)}–${f(props.max)}`
      }
      return `${f(lo)}–${f(hi)}`
    })
  }
  return (
    <div class="ramp-legend">
      <div class="ramp">
        <For each={props.ramp}>{(c) => <span style={{ background: c }} />}</For>
      </div>
      <div class="ramp-labels">
        <For each={labels()}>{(l) => <span>{l}</span>}</For>
      </div>
      <div class="hint">{props.unit}</div>
    </div>
  )
}

function Check(props: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
}): JSX.Element {
  return (
    <label class="check">
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(e) => {
          props.onChange(e.currentTarget.checked)
        }}
      />
      {props.label}
    </label>
  )
}

function Layers(): JSX.Element {
  return (
    <section>
      <h2>Map</h2>
      <label class="field">
        <span>Stops colored by</span>
        <select
          value={stopColor()}
          onChange={(e) => {
            setStopColor(e.currentTarget.value as StopColor)
          }}
        >
          <option value="score">
            {model() === 'potential' ? 'Potential (trip ends a day)' : 'Catchment score'}
          </option>
          <option value="freq">Trips per hour</option>
          <option value="perbus">Potential per bus</option>
          <option value="transit">Transit connections</option>
          <option value="riders">Riders vs. expected</option>
          <option value="adds">What it adds over neighbors</option>
        </select>
      </label>
      <Show when={stopColor() === 'score' && model() === 'potential'}>
        <Legend
          ramp={SCORE_RAMP[MODE]}
          breaks={POTENTIAL_BREAKS}
          format={(v) => `${String(v / 1000)}k`}
          unit="Trip ends a day by every mode within the walk, nearer counting more. Neighboring stops share trips. Circle size: trips per hour."
        />
      </Show>
      <Show when={stopColor() === 'score' && model() === 'tuned'}>
        <Legend
          ramp={SCORE_RAMP[MODE]}
          breaks={SCORE_BREAKS}
          unit="Score (0–100), tuned to today's riders. Circle size: trips per hour."
        />
      </Show>
      <Show when={stopColor() === 'freq'}>
        <Legend
          ramp={SCORE_RAMP[MODE]}
          breaks={FREQ_BREAKS}
          unit="Trips per hour. Circle size: trips per hour."
        />
      </Show>
      <Show when={stopColor() === 'transit'}>
        <Legend
          ramp={SCORE_RAMP[MODE]}
          breaks={SCORE_BREAKS}
          unit="Transit connections (0–100 against the best stop): jobs and destinations reachable by riding, nearer counting more. Circle size: trips per hour."
        />
      </Show>
      <Show when={stopColor() === 'adds'}>
        <Legend
          ramp={SCORE_RAMP[MODE]}
          breaks={ADDS_BREAKS}
          format={(v) => String(Math.round(v * 100))}
          unit={`Percent of the stop's catchment (10-minute walk, ${model() === 'potential' ? 'in trip ends' : 'current weights'}) that no other stop on its routes serves as well. Low: neighbors cover it. Hollow: no data.`}
        />
      </Show>
      <Show when={stopColor() === 'perbus'}>
        <Legend
          ramp={PERBUS_RAMP[MODE]}
          breaks={PERBUS_BREAKS}
          format={(v) => ({ 0.25: '¼', 0.5: '½', 1.25: '1¼' })[v] ?? String(v)}
          unit="Potential (trip ends a day, all modes) per weekday bus, times the median stop's. Teal: many trips nearby for the service it gets (under-served); brown: much service for the trips nearby. Hollow: no weekday service."
        />
      </Show>
      <Show when={stopColor() === 'riders'}>
        <Legend
          ramp={RIDERS_RAMP[MODE]}
          breaks={RIDERS_BREAKS}
          format={(v) => ({ 0.25: '¼', 0.5: '½', 1.25: '1¼' })[v] ?? String(v)}
          unit="Times as many weekday riders (Feb 2024) as the fitted model expects from the stop's catchment and service. Red: fewer; gray: about as expected; blue: more. Hollow: no ridership figure."
        />
      </Show>
      <h3 class="subhead">Transit reach</h3>
      <Check
        label="Show the selected stop's transit reach"
        checked={showTransitReach()}
        onChange={setShowTransitReach}
      />
      <Show when={showTransitReach()}>
        <Legend
          ramp={TRANSIT_REACH_RAMP[MODE]}
          breaks={TRANSIT_REACH_BREAKS}
          max={60}
          unit="Minutes from the selected stop by walking and riding (weekday morning, planning around the schedule). Replaces the trip generators below while a stop is selected."
        />
      </Show>
      <h3 class="subhead">Trip generators</h3>
      <Show
        when={transitReachActive()}
        fallback={
          <p class="hint">
            Pick one or more: with two, each hexagon splits in half (left, right); with three, into
            three wedges, in this order.
          </p>
        }
      >
        <p class="notice">
          Hidden while the transit reach is shown.{' '}
          <button type="button" class="link" onClick={() => setShowTransitReach(false)}>
            Show trip generators instead
          </button>
        </p>
      </Show>
      <For each={GENERATORS}>
        {(g) => (
          <>
            <Check
              label={GENERATOR_LABELS[g].label}
              checked={densities().includes(g)}
              onChange={(on) => {
                const next = new Set(densities())
                if (on) {
                  next.add(g)
                } else {
                  next.delete(g)
                }
                setDensities(GENERATORS.filter((x) => next.has(x)))
              }}
            />
            <Show when={densities().includes(g)}>
              <Legend
                ramp={DENSITY_RAMPS[g][MODE]}
                breaks={DENSITY_BREAKS[g]}
                unit={GENERATOR_LABELS[g].unit}
              />
            </Show>
          </>
        )}
      </For>
      <Show when={densities().length > 0}>
        <label class="slider">
          <span class="slider-label">
            Density opacity<output>{Math.round(densityOpacity() * 100)}%</output>
          </span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={densityOpacity()}
            onInput={(e) => setDensityOpacity(Number(e.currentTarget.value))}
          />
        </label>
      </Show>
      <label class="slider">
        <span class="slider-label">
          Catchment opacity<output>{Math.round(blobOpacity() * 100)}%</output>
        </span>
        <input
          type="range"
          min={0}
          max={0.9}
          step={0.05}
          value={blobOpacity()}
          onInput={(e) => setBlobOpacity(Number(e.currentTarget.value))}
        />
      </label>
      <Check label="Route lines" checked={showRoutes()} onChange={setShowRoutes} />
      <Check label="Walking-path spiderweb" checked={showSpiderweb()} onChange={setShowSpiderweb} />
      <Check label="Destination places (zoom in)" checked={showPois()} onChange={setShowPois} />
      <Check
        label="Arterial crossings the walk model allows"
        checked={showCrossings()}
        onChange={setShowCrossings}
      />
      <Show when={showCrossings()}>
        <ul class="key">
          <li>
            <span class="dot" style={{ background: '#0ca30c' }} />✓ Signalized
          </li>
          <li>
            <span class="dot" style={{ background: '#fab219' }} />! Marked, no signal
          </li>
        </ul>
        <p class="hint">
          Arterials can only be crossed at these points; anywhere else, walks detour to one.
        </p>
      </Show>
    </section>
  )
}

/** The map's left panel: always the same (intro, settings, layers); a selected stop's
 * details go in the right-hand StopDrawer instead. */
export default function Panel(): JSX.Element {
  return (
    <aside class="panel" classList={{ 'has-drawer': selected() !== null }}>
      <Show when={loadError()}>
        <p class="error">Couldn't load the data: {loadError()}</p>
      </Show>
      <h1>Madison Metro stop catchments</h1>
      <p class="lede">
        Who and what is within a short walk of each bus stop, and how often the bus comes. Hover a
        stop to preview its walkshed; click to see its details.
      </p>
      <Show when={data()}>
        <details class="group" open>
          <summary>Settings</summary>
          <Settings />
        </details>
        <details class="group" open>
          <summary>Layers</summary>
          <Layers />
        </details>
      </Show>
    </aside>
  )
}

/** The selected stop, in a drawer on the map's right (a bottom sheet on phones). */
export function StopDrawer(): JSX.Element {
  const navigate = useNavigate()
  return (
    <Show when={selected()}>
      {(s) => (
        <aside class="panel drawer" aria-label="Selected stop">
          <div class="detail-actions">
            <button
              class="link"
              onClick={() => {
                navigate(pathFor('stops'))
              }}
            >
              Open in stop analysis →
            </button>
            <button class="close" aria-label="Close" onClick={() => setSelectedId(null)}>
              ✕
            </button>
          </div>
          <StopDetail s={s()} />
        </aside>
      )}
    </Show>
  )
}
