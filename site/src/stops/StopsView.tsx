import { useNavigate } from '@solidjs/router'
import { createMemo, createSignal, type JSX, Show } from 'solid-js'

import Settings from '../components/Settings'
import StopDetail from '../components/StopDetail'
import { data, flyTo, scored, selected, selectedId, setSelectedId } from '../state/store'
import { pathFor } from '../state/url'
import StopTable from './StopTable'

export default function StopsView(): JSX.Element {
  const navigate = useNavigate()
  const [query, setQuery] = createSignal('')
  const routes = createMemo(() => new Map((data()?.routes ?? []).map((r) => [r.id, r])))
  const rows = createMemo(() => {
    const q = query().trim().toLowerCase()
    if (!q) {
      return scored()
    }
    // Match the name, a stop code, or a route (exact, so "A" doesn't match every name).
    return scored().filter(
      (s) =>
        s.stop.name.toLowerCase().includes(q) ||
        s.stop.codes.some((c) => c.toLowerCase() === q) ||
        s.stop.routes.some((r) => r.toLowerCase() === q),
    )
  })

  return (
    <div class="stops-view">
      <aside class="panel">
        <h1>Stop analysis</h1>
        <p class="lede">
          Every stop, merged where platforms share a corner. Scores and frequencies follow the
          settings below.
        </p>
        <Settings />
      </aside>
      <main class="table-col">
        <div class="table-tools">
          <input
            type="search"
            placeholder="Filter by stop name, stop code or route"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            aria-label="Filter stops"
          />
          <span class="muted">
            {rows().length} of {scored().length} stops
          </span>
        </div>
        <StopTable
          rows={rows()}
          routes={routes()}
          selectedId={selectedId()}
          onSelect={setSelectedId}
        />
        <p class="hint">
          Homes, jobs and other destinations are 0–100 against the best stop. Trips/h is per
          direction: each route's directions averaged, summed over routes. Riders ÷ exp. = weekday
          boardings (Feb 2024) ÷ what the ridership-fitted model expects.
        </p>
      </main>
      <Show when={selected()}>
        {(s) => (
          <aside class="panel detail-col">
            <div class="detail-actions">
              <button
                class="primary"
                onClick={() => {
                  navigate(pathFor('map'))
                  flyTo(s().stop.id)
                }}
              >
                Show walkshed on map
              </button>
              <button class="link" onClick={() => setSelectedId(null)}>
                Close
              </button>
            </div>
            <StopDetail s={s()} />
          </aside>
        )}
      </Show>
    </div>
  )
}
