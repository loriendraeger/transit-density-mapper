import { useNavigate } from '@solidjs/router'
import { For, type JSX, Show } from 'solid-js'

import {
  DENSITY_BREAKS,
  DENSITY_RAMP,
  FREQ_BREAKS,
  MODE,
  SCORE_BREAKS,
  SCORE_RAMP,
} from '../map/colors'
import {
  blobOpacity,
  data,
  type Density,
  density,
  densityOpacity,
  loadError,
  oneWayFactor,
  selected,
  setBlobOpacity,
  setDensity,
  setDensityOpacity,
  setSelectedId,
  setShowCrossings,
  setShowPois,
  setShowRoutes,
  setShowSpiderweb,
  setStopColor,
  showCrossings,
  showPois,
  showRoutes,
  showSpiderweb,
  type StopColor,
  stopColor,
} from '../state/store'
import { pathFor } from '../state/url'
import Settings from './Settings'
import StopDetail from './StopDetail'

function Legend(props: { ramp: string[]; breaks: readonly number[]; unit: string }): JSX.Element {
  function f(v: number): string {
    return v.toLocaleString('en-US')
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
      return hi === undefined ? `${f(lo)}+` : `${f(lo)}–${f(hi)}`
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
          <option value="score">Catchment score</option>
          <option value="freq">Trips per hour</option>
        </select>
      </label>
      <Legend
        ramp={SCORE_RAMP[MODE]}
        breaks={stopColor() === 'score' ? SCORE_BREAKS : FREQ_BREAKS}
        unit={
          stopColor() === 'score'
            ? 'Score (0–100). Circle size: trips per hour.'
            : 'Trips per hour. Circle size: trips per hour.'
        }
      />
      <ul class="key">
        <li>
          <svg class="oneway-key" viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="10" cy="10" r="5" class="dot-fill" />
            <circle cx="10" cy="10" r="8.5" class="ring" />
          </svg>
          One direction only: trips counted ×{oneWayFactor()}
        </li>
      </ul>
      <label class="field">
        <span>Density layer</span>
        <select
          value={density()}
          onChange={(e) => {
            setDensity(e.currentTarget.value as Density)
          }}
        >
          <option value="pop">Population</option>
          <option value="jobs">Jobs</option>
          <option value="none">None</option>
        </select>
      </label>
      <Show when={density() !== 'none'}>
        <Legend
          ramp={DENSITY_RAMP[MODE]}
          breaks={DENSITY_BREAKS[density() as 'pop' | 'jobs']}
          unit={density() === 'pop' ? 'Residents per km²' : 'Jobs per km²'}
        />
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
      <Check label="Destinations (zoom in)" checked={showPois()} onChange={setShowPois} />
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
