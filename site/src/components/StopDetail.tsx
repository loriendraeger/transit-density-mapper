import { createMemo, createSignal, For, type JSX, Show } from 'solid-js'

import { DAY_TYPES, type DayType, type Period, PERIODS, type Route } from '../lib/contract'
import { periodFreq, type Scored } from '../lib/scoring'
import { compact, fmt, headwayMin } from '../lib/units'
import {
  data,
  period,
  setShowTransitReach,
  showTransitReach,
  walkMin,
  weights,
} from '../state/store'
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

const TRANSIT_MINUTES = [15, 30, 45, 60]

const SPECIAL_LABELS: Record<string, string> = {
  school: 'school',
  campus: 'campus',
  park_ride: 'park-and-ride',
  airport: 'airport',
  transfer: 'transfer point',
}

/** ×21 more / ×0.1 = 10 times fewer / about as expected. */
function ratioText(x: number): string {
  if (x >= 1.25) {
    return `${fmt(x, x < 10 ? 1 : 0)}× more than expected`
  }
  if (x <= 0.8) {
    return `${fmt(1 / x, 1 / x < 10 ? 1 : 0)}× fewer than expected`
  }
  return 'about as expected'
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
  /** Reached by transit within t minutes (cumulative over the access bands). */
  function byTransit(key: 'jobs' | 'homes', t: number): number {
    const a = stop().access
    const bandMin = data()?.settings.score.access.band_min ?? 2
    if (!a) {
      return 0
    }
    return a[key].slice(0, Math.floor(t / bandMin)).reduce((x, y) => x + y, 0)
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
            trips/hour per direction
            <Show when={headwayMin(props.s.freq)}>{(h) => <> · every {fmt(h(), 0)} min</>}</Show>
          </span>
        </div>
      </div>

      <Show when={stop().riders}>
        {(r) => (
          <>
            <h2>Riders vs. expected</h2>
            <p>
              <strong>{fmt(r().observed, 0)}</strong> weekday boardings (February 2024); the fitted
              model expects <strong>{fmt(r().expected, 0)}</strong> from this stop's catchment and
              service ({ratioText(props.s.riders ?? 1)}).
            </p>
            <Show when={stop().special.length}>
              <p class="hint">
                Special stop (
                {stop()
                  .special.map((s) => SPECIAL_LABELS[s] ?? s)
                  .join(', ')}
                ): riders come for more than what's within walking distance, so it was left out of
                the fit.
              </p>
            </Show>
            <p class="hint">
              Expected = the default assumption's fit (not the sliders) × weekday trips/hour. 2024
              ridership predates the BRT (Sept 2024), so stops whose service changed since may be
              off.
            </p>
          </>
        )}
      </Show>

      <Show when={stop().overlap}>
        {(o) => (
          <>
            <h2>What it adds over its neighbors</h2>
            <p>
              <strong>{fmt((props.s.adds ?? 0) * 100, 0)} %</strong> of this stop's catchment isn't
              served as well by another stop on its routes.{' '}
              {o().residents > 0
                ? `${compact(o().residents_far)} of the ${compact(o().residents)} residents within ${String(data()?.settings.score.walk_min ?? 10)} minutes would walk 2+ minutes more without it.`
                : ''}
            </p>
            <p class="hint">
              At the default {data()?.settings.score.walk_min ?? 10}-minute walk and{' '}
              {data()?.settings.score.half_life_min ?? 4}-minute half-life: for each home, job and
              destination, its weight at this stop minus its weight at the nearest other stop
              sharing a route. Low values mean neighbors cover the same ground.
            </p>
          </>
        )}
      </Show>

      <h2>What's within {walkMin()} minutes</h2>
      <Meter
        label="Homes"
        value={props.s.norm.pop}
        detail={`${compact(within('pop'))} residents (2020 Census plus new housing, placed by dwelling units)`}
      />
      <Meter
        label="Jobs"
        value={props.s.norm.jobs}
        detail={`${compact(within('jobs'))} jobs (LODES 2023)`}
      />
      <Meter
        label="Other destinations"
        value={props.s.norm.dest}
        detail={
          topCategories().length
            ? `Most from ${topCategories()
                .map(([c]) => c)
                .join(', ')}`
            : 'None in reach'
        }
      />
      <Meter
        label="Transit connections"
        value={props.s.norm.transit}
        detail={`${compact(byTransit('jobs', 30))} jobs within 30 minutes by transit`}
      />
      <p class="hint">
        Scores are 0–100 against the best stop at these settings; the overall score weights them{' '}
        {weights().pop}:{weights().jobs}:{weights().dest}:{weights().transit}.
      </p>

      <Show when={stop().access}>
        <h2>By transit</h2>
        <table class="mini">
          <thead>
            <tr>
              <th />
              <For each={TRANSIT_MINUTES}>{(t) => <th class="num">{t} min</th>}</For>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Jobs reachable</td>
              <For each={TRANSIT_MINUTES}>
                {(t) => <td class="num">{compact(byTransit('jobs', t))}</td>}
              </For>
            </tr>
            <tr>
              <td>Residents who can get here</td>
              <For each={TRANSIT_MINUTES}>
                {(t) => <td class="num">{compact(byTransit('homes', t))}</td>}
              </For>
            </tr>
          </tbody>
        </table>
        <p class="hint">
          Walking and riding, weekday {data()?.settings.score.access.departure_hour ?? 7}–
          {(data()?.settings.score.access.departure_hour ?? 7) +
            (data()?.settings.score.access.window_hours ?? 2)}{' '}
          am, for a rider who plans around the schedule (the{' '}
          {data()?.settings.score.access.percentile ?? 10}th-percentile trip over every departure
          minute).{' '}
          <button
            type="button"
            class="link"
            onClick={() => setShowTransitReach(!showTransitReach())}
          >
            {showTransitReach() ? 'Hide' : 'Show'} the reach on the map
          </button>
          .
        </p>
      </Show>

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
      <p class="hint">
        All routes, both directions, buses you can board, on {data()?.rep_dates[day()] ?? ''}.
      </p>

      <h2>Trips per hour by route</h2>
      <p class="hint">Per direction: the average of the directions each route runs here.</p>
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
            <td>All</td>
            <For each={PERIODS}>{(p) => <td class="num">{fmt(periodFreq(stop(), p), 1)}</td>}</For>
          </tr>
        </tbody>
      </table>
    </article>
  )
}
