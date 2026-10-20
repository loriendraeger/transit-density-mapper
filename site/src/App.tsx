import { type RouteSectionProps, useNavigate } from '@solidjs/router'
import { For, type JSX, Show } from 'solid-js'

import About from './about/About'
import Panel, { StopDrawer } from './components/Panel'
import MapView from './map/MapView'
import { type View, view } from './state/store'
import { pathFor, UrlSync } from './state/url'
import StopsView from './stops/StopsView'

const TABS: { id: View; label: string }[] = [
  { id: 'map', label: 'Map' },
  { id: 'stops', label: 'Stop analysis' },
  { id: 'about', label: 'About' },
]

/** The router's root: every route renders this shell; the route picks the view. */
export default function App(props: RouteSectionProps): JSX.Element {
  const navigate = useNavigate()
  return (
    <div class="app">
      <UrlSync />
      {props.children}
      <header class="topbar">
        <span class="brand">Stop catchments</span>
        <nav class="tabs" role="tablist" aria-label="View">
          <For each={TABS}>
            {(t) => (
              <button
                role="tab"
                aria-selected={view() === t.id}
                onClick={() => {
                  navigate(pathFor(t.id))
                }}
              >
                {t.label}
              </button>
            )}
          </For>
        </nav>
      </header>
      {/* The map stays mounted (hidden) on the other tabs, so it isn't rebuilt. */}
      <div class="body" classList={{ hidden: view() !== 'map' }}>
        <Panel />
        <MapView />
        <StopDrawer />
      </div>
      <Show when={view() === 'stops'}>
        <div class="body">
          <StopsView />
        </div>
      </Show>
      <Show when={view() === 'about'}>
        <main class="body scroll">
          <About />
        </main>
      </Show>
    </div>
  )
}
