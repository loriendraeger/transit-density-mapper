import './styles.css'

import { HashRouter, Navigate, Route } from '@solidjs/router'
import { render } from 'solid-js/web'

import App from './App'
import { loadStops } from './lib/data'
import { initFromData, setLoadError } from './state/store'

const root = document.getElementById('root')
if (!root) {
  throw new Error('index.html is missing #root')
}
loadStops()
  .then(initFromData)
  .catch((e: unknown) => {
    console.error('Failed to load stops.json', e)
    setLoadError(String(e))
  })
// Hash URLs (#/map, #/stops, #/about): GitHub Pages can't serve index.html for other paths.
// App is the shell for every route; the routes themselves render nothing.
render(
  () => (
    <HashRouter root={App}>
      <Route path="/map" />
      <Route path="/stops" />
      <Route path="/about" />
      <Route path="*" component={() => <Navigate href="/map" />} />
    </HashRouter>
  ),
  root,
)
