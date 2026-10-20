import { createMemo, createSignal, For, type JSX, Show } from 'solid-js'

import { DAY_TYPES, type DayType, type Period, PERIODS, type Route } from '../lib/contract'
import { periodFreq, type Scored } from '../lib/scoring'
import { compact, fmt, headwayMin } from '../lib/units'
import { data, oneWayFactor, period, walkMin, weights } from '../state/store'
import HourlyChart from './HourlyChart'
import { PERIOD_LABELS } from './Settings'

const DAY_LABELS: Record<DayType, string> = {
  weekday: 'Weekday',
  saturday: 'Saturday',
  sunday: 'Sunday',
}

export function RouteChip(props: { route: Route | undefined; id: string }): JSX.Element {
  return (
    <span
      class="chip"
      style={{
        background: `#${props.route?.color ?? '888888'}`,
        color: `#${props.route?.text_color ?? 'ffffff'}`,
      }}
      title={props.route?.description ?? undefined}
    >
      {props.route?.name ?? props.id}
    </span>
  )
}

/** Score component as a meter: 0-100 against the best stop. */
function Meter(props: { label: string; value: number; detail: string }): JSX.Element {
  return (
    <div class="meter">
      <div class="meter-head">
        <span>{props.label}</span>
        <span class="num">{fmt(props.value, 0)}</span>
      </div>
      <div class="meter-track">
        <div
          class="meter-fill"
          style={{ width: `${String(Math.max(0, Math.min(100, props.value)))}%` }}
        />
      </div>
      <div class="hint">{props.detail}</div>
    </div>
  )
}

export default function StopDetail(props: { s: Scored }): JSX.Element {
  const [day, setDay] = createSignal<DayType>('weekday')
  const routes = createMemo(() => new Map((data()?.routes ?? []).map((r) => [r.id, r])))
  function stop(): Scored['stop'] {
    return props.s.stop
  }

  /** Plain totals within the walk limit (no decay), for the explanation lines. */
  function within(id: string): number {
    const d = data()
    if (!d) {
      return 0
    }
    const n = Math.floor(walkMin() / d.settings.band_min)
    return (stop().bands[id] ?? []).slice(0, n).reduce((a, b) => a + b, 0)
  }
  const topCategories = createMemo(() =>
    Object.entries(props.s.raw.categories)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5),
  )
  const routeRows = createMemo(() =>
    stop()
      .routes.map((id) => ({
        id,
        order: routes().get(id)?.sort_order ?? 999,
        freq: Object.fromEntries(PERIODS.map((p) => [p, stop().freq[p]?.[id] ?? 0])) as Record<
          Period,
          number
        >,
      }))
      .sort((a, b) => a.order - b.order),
  )

  return (
    <article class="stop-detail">
      <header>
        <h1>{stop().name}</h1>
        <p class="muted">
          Stop {stop().codes.join(', ')}
          <Show when={stop().codes.length > 1}> (merged)</Show>
        </p>
        <div class="chips">
          <For each={stop().routes}>{(id) => <RouteChip id={id} route={routes().get(id)} />}</For>
        </div>
      </header>

      <div class="tiles">
        <div class="tile">
          <span class="tile-label">Catchment score</span>
          <span class="tile-value">{fmt(props.s.score, 0)}</span>
          <span class="hint">
            rank {props.s.rank} of {data()?.stops.length ?? 0}
          </span>
        </div>
        <div class="tile">
          <span class="tile-label">{PERIOD_LABELS[period()]}</span>
          <span class="tile-value">{fmt(props.s.freq, 1)}</span>
          <span class="hint">
            trips/hour
            <Show when={headwayMin(props.s.freq)}>{(h) => <> · every {fmt(h(), 0)} min</>}</Show>
          </span>
        </div>
      </div>
      <Show when={stop().one_way}>
        <p class="hint">
          ◎ One-directional stop: buses here all head the same way, so its trips count ×
          {oneWayFactor()}.
        </p>
      </Show>

      <h2>What's within {walkMin()} minutes</h2>
      <Meter
        label="Population"
        value={props.s.norm.pop}
        detail={`${compact(within('pop'))} residents (2020 Census, placed by dwelling units)`}
      />
      <Meter
        label="Jobs"
        value={props.s.norm.jobs}
        detail={`${compact(within('jobs'))} jobs (LODES 2023)`}
      />
      <Meter
        label="Destinations"
        value={props.s.norm.dest}
        detail={
          topCategories().length
            ? `Most from ${topCategories()
                .map(([c]) => c)
                .join(', ')}`
            : 'None in reach'
        }
      />
      <p class="hint">
        Scores are 0–100 against the best stop at these settings; the overall score weights them{' '}
        {weights().pop}:{weights().jobs}:{weights().dest}.
      </p>

      <h2>Departures by hour</h2>
      <div class="segmented" role="radiogroup" aria-label="Day">
        <For each={DAY_TYPES}>
          {(d) => (
            <button role="radio" aria-checked={day() === d} onClick={() => setDay(d)}>
              {DAY_LABELS[d]}
            </button>
          )}
        </For>
      </div>
      <HourlyChart counts={stop().hourly[day()]} />
      <p class="hint">All routes, buses you can board, on {data()?.rep_dates[day()] ?? ''}.</p>

      <h2>Trips per hour by route</h2>
      <table class="mini">
        <thead>
          <tr>
            <th>Route</th>
            <For each={PERIODS}>
              {(p) => <th class="num">{PERIOD_LABELS[p].replace('Weekday ', '')}</th>}
            </For>
          </tr>
        </thead>
        <tbody>
          <For each={routeRows()}>
            {(r) => (
              <tr>
                <td>
                  <RouteChip id={r.id} route={routes().get(r.id)} />
                </td>
                <For each={PERIODS}>
                  {(p) => <td class="num">{r.freq[p] ? fmt(r.freq[p], 1) : '–'}</td>}
                </For>
              </tr>
            )}
          </For>
          <tr class="total">
            <td>All{stop().one_way ? ` ×${String(oneWayFactor())}` : ''}</td>
            <For each={PERIODS}>
              {(p) => <td class="num">{fmt(periodFreq(stop(), p, oneWayFactor()), 1)}</td>}
            </For>
          </tr>
        </tbody>
      </table>
    </article>
  )
}
