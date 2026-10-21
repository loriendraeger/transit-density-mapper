import 'maplibre-gl/dist/maplibre-gl.css'

import { layers } from '@protomaps/basemaps'
import type { FeatureCollection, Point } from 'geojson'
import {
  addProtocol,
  AttributionControl,
  type ExpressionSpecification,
  type FilterSpecification,
  type GeoJSONSource,
  Map as MlMap,
  NavigationControl,
  Popup,
  setWorkerUrl,
} from 'maplibre-gl'
// MapLibre finds its worker as a sibling file of its own module, which no longer holds
// once a bundler moves the module. Let Vite bundle the worker and pass its URL instead.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { PMTiles, Protocol } from 'pmtiles'
import {
  createEffect,
  createSignal,
  getOwner,
  type JSX,
  on,
  onCleanup,
  onMount,
  runWithOwner,
  untrack,
} from 'solid-js'

import { blobFeatures, type Catchment, loadCatchment } from '../lib/catchment'
import {
  CROSSINGS_LAYER,
  HEX_LAYER,
  HEX_PARTS_LAYER,
  PLATFORMS_LAYER,
  POIS_LAYER,
  ROUTES_LAYER,
  WALK_LAYER,
} from '../lib/contract'
import { dataUrl } from '../lib/data'
import { bandWeights } from '../lib/scoring'
import { fmt } from '../lib/units'
import {
  blobOpacity,
  data,
  decay,
  DEFAULT_WALK_MIN,
  densities,
  densityOpacity,
  flyRequest,
  scored,
  selectedId,
  setSelectedId,
  showCrossings,
  showPois,
  showRoutes,
  showSpiderweb,
  stopColor,
  walkMin,
  weights,
} from '../state/store'
import {
  CATCHMENT,
  DENSITY_BREAKS,
  DENSITY_FIELD,
  DENSITY_RAMPS,
  FREQ_BREAKS,
  type Generator,
  INK_2,
  MODE,
  neutralFlavor,
  SCORE_BREAKS,
  SCORE_RAMP,
  stepExpr,
  SURFACE,
} from './colors'

setWorkerUrl(workerUrl)
const protocol = new Protocol()
addProtocol('pmtiles', protocol.tile)

interface StopProps {
  id: string
  name: string
  score: number
  freq: number
  r: number
}

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] }
const HOVER_DELAY_MS = 150
const HOVER_OPACITY = 0.4

export default function MapView(): JSX.Element {
  let container: HTMLDivElement | undefined
  /** The stop under the mouse (for the hover preview). */
  const [hoverId, setHoverId] = createSignal<string | null>(null)
  const mode = MODE

  onMount(() => {
    if (!container) {
      throw new Error('map container not mounted')
    }
    const owner = getOwner()
    const basemap = new PMTiles(dataUrl('basemap.pmtiles'))
    protocol.add(basemap)
    const flavor = mode === 'dark' ? 'dark' : 'light'

    const m = new MlMap({
      container,
      center: [-89.385, 43.075],
      zoom: 12,
      attributionControl: false,
      style: {
        version: 8,
        glyphs: 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf',
        sprite: `https://protomaps.github.io/basemaps-assets/sprites/v4/${flavor}`,
        sources: {
          protomaps: {
            type: 'vector',
            url: `pmtiles://${basemap.source.getKey()}`,
            attribution:
              '<a href="https://protomaps.com">Protomaps</a> © <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>',
          },
          network: {
            type: 'vector',
            url: `pmtiles://${dataUrl('network.pmtiles')}`,
          },
          generators: {
            type: 'vector',
            url: `pmtiles://${dataUrl('generators.pmtiles')}`,
            attribution:
              'Data provided under license granted by City of Madison, WI, Metro Transit · U.S. Census Bureau (2020 Census, LODES) · City of Madison · WI Statewide Parcel Map',
          },
          stops: { type: 'geojson', data: EMPTY, promoteId: 'id' },
          blob: { type: 'geojson', data: EMPTY },
          'blob-hover': { type: 'geojson', data: EMPTY },
        },
        layers: layers('protomaps', neutralFlavor(mode), { lang: 'en' }),
      },
    })
    m.addControl(new AttributionControl({ compact: true }))
    m.addControl(new NavigationControl({ showCompass: false }), 'top-right')
    onCleanup(() => {
      m.remove()
    })

    m.on('load', () => {
      // The compact attribution starts expanded; on a phone it covers the map.
      container
        ?.querySelector('.maplibregl-ctrl-attrib')
        ?.classList.remove('maplibregl-compact-show')
      addLayers(m)
      runWithOwner(owner, () => {
        bindSignals(m)
      })
      void basemap.getHeader().then((h) => {
        m.setMaxBounds([
          [h.minLon - 0.05, h.minLat - 0.05],
          [h.maxLon + 0.05, h.maxLat + 0.05],
        ])
      })
    })
  })

  function addLayers(m: MlMap): void {
    const ink2 = INK_2[mode]
    const surface = SURFACE[mode]
    // Under the place labels of the basemap, so street names stay readable.
    const beforeLabels = m.getStyle().layers.find((l) => l.type === 'symbol')?.id

    // Generator density hexes: whole hexes for one generator, halves for two, thirds
    // for three (one piece per generator); only one of these layers is visible at a time.
    const densityLayers: [string, string, FilterSpecification | null][] = [
      ['density', HEX_LAYER, null],
      ['density-half', HEX_PARTS_LAYER, ['==', ['get', 'split'], 'half']],
      ['density-third', HEX_PARTS_LAYER, ['==', ['get', 'split'], 'third']],
    ]
    for (const [id, layer, filter] of densityLayers) {
      m.addLayer(
        {
          id,
          type: 'fill',
          source: 'generators',
          'source-layer': layer,
          ...(filter ? { filter } : {}),
          layout: { visibility: 'none' },
          paint: { 'fill-color': surface, 'fill-opacity': 0.5 },
        },
        beforeLabels,
      )
    }
    m.addLayer(
      {
        id: 'blob',
        type: 'fill',
        source: 'blob',
        paint: {
          'fill-color': CATCHMENT[mode],
          'fill-opacity': ['get', 'alpha'],
          'fill-antialias': false,
        },
      },
      beforeLabels,
    )
    // Hover preview: another stop's blob, fainter, so it reads as a preview.
    m.addLayer(
      {
        id: 'blob-hover',
        type: 'fill',
        source: 'blob-hover',
        paint: {
          'fill-color': CATCHMENT[mode],
          'fill-opacity': ['*', HOVER_OPACITY, ['get', 'alpha']],
          'fill-antialias': false,
        },
      },
      beforeLabels,
    )
    // ...with a dashed outline at the walk-time limit, so it stays distinct from the
    // selected stop's blob where they overlap (filter set with the walk time below).
    m.addLayer({
      id: 'blob-hover-outline',
      type: 'line',
      source: 'blob-hover',
      filter: ['==', ['get', 'band'], DEFAULT_WALK_MIN],
      paint: {
        'line-color': mode === 'dark' ? '#f0efec' : '#2c2c2a',
        'line-width': 1.5,
        'line-dasharray': [3, 2],
      },
    })
    // Route lines in Metro's own route colors (identity, as on Metro's maps); context
    // only, under everything interactive.
    m.addLayer({
      id: 'routes',
      type: 'line',
      source: 'generators',
      'source-layer': ROUTES_LAYER,
      layout: {
        'line-cap': 'round',
        'line-join': 'round',
        // BRT (lower sort order) on top.
        'line-sort-key': ['-', 1000, ['get', 'sort_order']],
      },
      paint: {
        'line-color': ['get', 'color'],
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1, 14, 2.5, 17, 4],
        'line-opacity': 0.75,
      },
    })
    m.addLayer({
      id: 'spiderweb',
      type: 'line',
      source: 'network',
      'source-layer': WALK_LAYER,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': CATCHMENT[mode],
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.6, 16, 2.5],
        'line-opacity': 0,
      },
    })
    // The hovered stop's spiderweb: thin and gray, under the selected one's violet.
    m.addLayer(
      {
        id: 'spiderweb-hover',
        type: 'line',
        source: 'network',
        'source-layer': WALK_LAYER,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': mode === 'dark' ? '#f0efec' : '#2c2c2a',
          'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.5, 16, 1.5],
          'line-opacity': 0,
        },
      },
      'spiderweb',
    )
    m.addLayer({
      id: 'crossings',
      type: 'circle',
      source: 'network',
      'source-layer': CROSSINGS_LAYER,
      minzoom: 13,
      layout: { visibility: 'none' },
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 2, 17, 6],
        // Control: 3 signal, 2 marked. Status-like, but labeled in the legend.
        'circle-color': ['match', ['get', 'control'], 3, '#0ca30c', 2, '#fab219', '#d03b3b'],
        'circle-stroke-color': surface,
        'circle-stroke-width': 1,
      },
    })
    m.addLayer({
      id: 'destinations',
      type: 'circle',
      source: 'generators',
      'source-layer': POIS_LAYER,
      minzoom: 12,
      layout: { visibility: 'none' },
      paint: {
        'circle-radius': [
          'interpolate',
          ['linear'],
          ['zoom'],
          12,
          ['+', 1, ['sqrt', ['get', 'weight']]],
          17,
          ['+', 3, ['*', 1.5, ['sqrt', ['get', 'weight']]]],
        ],
        'circle-color': ink2,
        'circle-opacity': 0.75,
        'circle-stroke-color': surface,
        'circle-stroke-width': 1,
      },
    })
    m.addLayer({
      id: 'platforms',
      type: 'circle',
      source: 'generators',
      'source-layer': PLATFORMS_LAYER,
      minzoom: 15,
      paint: {
        'circle-radius': 3,
        'circle-color': surface,
        'circle-stroke-color': ink2,
        'circle-stroke-width': 1.5,
      },
    })
    const r: ExpressionSpecification = ['get', 'r']
    m.addLayer({
      id: 'stops',
      type: 'circle',
      source: 'stops',
      paint: {
        'circle-radius': [
          'interpolate',
          ['linear'],
          ['zoom'],
          10,
          ['*', 0.4, r],
          14,
          r,
          17,
          ['*', 1.6, r],
        ],
        'circle-color': SCORE_RAMP[mode][2],
        'circle-stroke-color': [
          'case',
          ['boolean', ['feature-state', 'selected'], false],
          mode === 'dark' ? '#f0efec' : '#0b0b0b',
          surface,
        ],
        // Zoom must be the outermost input, so the selection test sits inside it.
        'circle-stroke-width': [
          'interpolate',
          ['linear'],
          ['zoom'],
          10,
          ['case', ['boolean', ['feature-state', 'selected'], false], 3, 0.5],
          14,
          ['case', ['boolean', ['feature-state', 'selected'], false], 3, 1.5],
        ],
      },
    })
    m.addLayer({
      id: 'stop-labels',
      type: 'symbol',
      source: 'stops',
      minzoom: 14.5,
      layout: {
        'text-field': ['get', 'name'],
        'text-font': ['Noto Sans Regular'],
        'text-size': 11,
        'text-offset': [0, 1.2],
        'text-anchor': 'top',
        'text-optional': true,
      },
      paint: {
        'text-color': mode === 'dark' ? '#f0efec' : '#0b0b0b',
        'text-halo-color': surface,
        'text-halo-width': 1.5,
      },
    })

    // Interaction: click a stop to select it; click elsewhere to clear.
    const popup = new Popup({ closeButton: false, closeOnClick: false, offset: 10 })
    m.on('mousemove', 'stops', (e) => {
      const f = e.features?.[0]
      if (!f) {
        return
      }
      m.getCanvas().style.cursor = 'pointer'
      const p = f.properties as StopProps
      if (untrack(hoverId) !== p.id) {
        setHoverId(p.id)
      }
      const geom = f.geometry as Point
      popup
        .setLngLat(geom.coordinates as [number, number])
        .setHTML(
          `<strong>${escapeHtml(p.name)}</strong><br>Score ${fmt(p.score, 0)} · ${fmt(p.freq, 1)} trips/h`,
        )
        .addTo(m)
    })
    m.on('mouseleave', 'stops', () => {
      m.getCanvas().style.cursor = ''
      popup.remove()
      setHoverId(null)
    })
    m.on('click', (e) => {
      const hit = m.queryRenderedFeatures(e.point, { layers: ['stops'] }).at(0)
      setSelectedId(hit ? (hit.properties as StopProps).id : null)
    })
  }

  function bindSignals(m: MlMap): void {
    const maybeStops = m.getSource<GeoJSONSource>('stops')
    const maybeBlob = m.getSource<GeoJSONSource>('blob')
    if (!maybeStops || !maybeBlob) {
      throw new Error('map sources missing')
    }
    const stopsSrc: GeoJSONSource = maybeStops
    const blobSrc: GeoJSONSource = maybeBlob

    // Fit the stops once they arrive (unless a stop is selected: the fly handles that).
    createEffect(
      on(data, (d) => {
        if (!d || selectedId()) {
          return
        }
        const lons = d.stops.map((s) => s.lon)
        const lats = d.stops.map((s) => s.lat)
        m.fitBounds(
          [
            [Math.min(...lons), Math.min(...lats)],
            [Math.max(...lons), Math.max(...lats)],
          ],
          { padding: 30, duration: 0 },
        )
      }),
    )

    // Stops: positions and current score/frequency.
    createEffect(() => {
      const features = scored().map((s) => ({
        type: 'Feature' as const,
        id: s.stop.id,
        geometry: { type: 'Point' as const, coordinates: [s.stop.lon, s.stop.lat] },
        properties: {
          id: s.stop.id,
          name: s.stop.name,
          score: s.score,
          freq: s.freq,
          // Radius grows with the square root of frequency, so area tracks trips/hour.
          r: 3 + 2 * Math.sqrt(s.freq),
        } satisfies StopProps,
      }))
      // Busiest stops draw last (on top).
      features.sort((a, b) => a.properties.freq - b.properties.freq)
      void stopsSrc.setData({ type: 'FeatureCollection', features })
    })
    createEffect(() => {
      const byFreq = stopColor() === 'freq'
      m.setPaintProperty(
        'stops',
        'circle-color',
        stepExpr(
          ['get', byFreq ? 'freq' : 'score'],
          SCORE_RAMP[mode],
          byFreq ? FREQ_BREAKS : SCORE_BREAKS,
        ),
      )
    })

    // Selected stop's ring.
    let lastSel: string | null = null
    createEffect(() => {
      const id = selectedId()
      if (lastSel !== null) {
        m.setFeatureState({ source: 'stops', id: lastSel }, { selected: false })
      }
      if (id !== null) {
        m.setFeatureState({ source: 'stops', id }, { selected: true })
      }
      lastSel = id
    })

    // Density layers: the selected generators, in GENERATORS order, get the hex pieces
    // (slot 0, 1, 2) of the layer matching their count.
    /** A generator's density in a hex. Destinations: the per-category densities
     * (d_<category>) weighted by the destination category weights, so re-weighting
     * categories recolors the layer. */
    function densityValue(g: Generator): ExpressionSpecification {
      if (g !== 'dest') {
        return ['get', DENSITY_FIELD[g]]
      }
      const terms = Object.entries(weights().categories)
        .filter(([, w]) => w > 0)
        .map(([cat, w]): ExpressionSpecification => ['*', w, ['coalesce', ['get', `d_${cat}`], 0]])
      return terms.length ? (['+', 0, ...terms] as ExpressionSpecification) : ['literal', 0]
    }
    function densityRamp(g: Generator): ExpressionSpecification {
      return stepExpr(densityValue(g), DENSITY_RAMPS[g][mode], DENSITY_BREAKS[g])
    }
    createEffect(() => {
      const gens = densities()
      const active = ['', 'density', 'density-half', 'density-third'].at(gens.length) ?? ''
      // Fade the density under a catchment so the blob reads.
      const op = densityOpacity() * (selectedId() ? 0.3 : 1)
      for (const id of ['density', 'density-half', 'density-third']) {
        m.setLayoutProperty(id, 'visibility', id === active ? 'visible' : 'none')
        m.setPaintProperty(id, 'fill-opacity', op)
      }
      const ramps = gens.map(densityRamp)
      if (ramps.length === 1) {
        m.setPaintProperty(active, 'fill-color', ramps[0])
      } else if (ramps.length > 1) {
        // Piece `slot` shows the slot-th selected generator.
        const cases = ramps.slice(0, -1).flatMap((r, i) => [i, r])
        m.setPaintProperty(active, 'fill-color', [
          'match',
          ['get', 'slot'],
          ...cases,
          ramps[ramps.length - 1],
        ] as unknown as ExpressionSpecification)
      }
    })
    createEffect(() => {
      m.setLayoutProperty('destinations', 'visibility', showPois() ? 'visible' : 'none')
    })
    createEffect(() => {
      m.setLayoutProperty('crossings', 'visibility', showCrossings() ? 'visible' : 'none')
    })
    createEffect(() => {
      m.setLayoutProperty('routes', 'visibility', showRoutes() ? 'visible' : 'none')
    })

    // Catchment of the selected stop: load, then paint the blob and the spiderweb.
    let catchment: Catchment | null = null
    createEffect(
      on(selectedId, (id) => {
        m.removeFeatureState({ source: 'network', sourceLayer: WALK_LAYER })
        catchment = null
        void blobSrc.setData(EMPTY)
        if (id === null) {
          return
        }
        loadCatchment(id)
          .then((c) => {
            if (selectedId() !== id) {
              return
            }
            catchment = c
            for (const [edge, t] of c.edges) {
              m.setFeatureState({ source: 'network', sourceLayer: WALK_LAYER, id: edge }, { t })
            }
            paintCatchment()
          })
          .catch((e: unknown) => {
            console.error(e)
          })
      }),
    )
    function paintCatchment(): void {
      const d = data()
      const walk = walkMin()
      if (!d || !catchment) {
        void blobSrc.setData(EMPTY)
        return
      }
      const n = d.settings.max_walk_min / d.settings.band_min
      // The blob fades like the score's decay (no decay: a flat blob to the limit).
      const w = bandWeights(decay(), walk, n, d.settings.band_min)
      void blobSrc.setData(blobFeatures(catchment, w, blobOpacity()))
      const limit = walk * 60
      const t: ExpressionSpecification = ['coalesce', ['feature-state', 't'], 1e9]
      m.setPaintProperty(
        'spiderweb',
        'line-opacity',
        showSpiderweb()
          ? ['case', ['<=', t, limit], ['interpolate', ['linear'], t, 0, 0.95, limit, 0.3], 0]
          : 0,
      )
    }
    createEffect(
      on([walkMin, decay, blobOpacity, showSpiderweb], () => {
        paintCatchment()
      }),
    )

    // Hover preview: after a short pause on a stop (so sweeping across stops doesn't
    // fetch them all), show its blob faintly and its spiderweb in gray. Not for the
    // selected stop. The spiderweb uses its own feature-state key (h) on the same tiles.
    const hoverSrc = m.getSource<GeoJSONSource>('blob-hover')
    let hoverTimer: ReturnType<typeof setTimeout> | undefined
    let hoverEdges: number[] = []
    function clearHoverWeb(): void {
      for (const id of hoverEdges) {
        m.removeFeatureState({ source: 'network', sourceLayer: WALK_LAYER, id }, 'h')
      }
      hoverEdges = []
    }
    createEffect(
      on([hoverId, selectedId, walkMin, decay, blobOpacity], ([id, sel]) => {
        clearTimeout(hoverTimer)
        void hoverSrc?.setData(EMPTY)
        clearHoverWeb()
        const limit = untrack(walkMin) * 60
        const h: ExpressionSpecification = ['coalesce', ['feature-state', 'h'], 1e9]
        m.setPaintProperty('spiderweb-hover', 'line-opacity', [
          'case',
          ['<=', h, limit],
          ['interpolate', ['linear'], h, 0, 0.7, limit, 0.15],
          0,
        ])
        m.setFilter('blob-hover-outline', ['==', ['get', 'band'], untrack(walkMin)])
        const d = data()
        if (id === null || id === sel || !d) {
          return
        }
        hoverTimer = setTimeout(() => {
          loadCatchment(id)
            .then((c) => {
              untrack(() => {
                if (hoverId() !== id) {
                  return
                }
                const n = d.settings.max_walk_min / d.settings.band_min
                const w = bandWeights(decay(), walkMin(), n, d.settings.band_min)
                void hoverSrc?.setData(blobFeatures(c, w, blobOpacity()))
                if (showSpiderweb()) {
                  for (const [edge, t] of c.edges) {
                    m.setFeatureState(
                      { source: 'network', sourceLayer: WALK_LAYER, id: edge },
                      { h: t },
                    )
                  }
                  hoverEdges = [...c.edges.keys()]
                }
              })
            })
            .catch((e: unknown) => {
              console.error(e)
            })
        }, HOVER_DELAY_MS)
      }),
    )
    onCleanup(() => {
      clearTimeout(hoverTimer)
    })

    // Fly to a stop on request (table "show on map", or a shared link): head there
    // right away, then frame its walkshed at the current limit once that's loaded.
    createEffect(
      on(flyRequest, (req) => {
        const stop = req ? data()?.stops.find((s) => s.id === req.id) : undefined
        if (!stop) {
          return
        }
        m.flyTo({ center: [stop.lon, stop.lat], zoom: Math.max(m.getZoom(), 14.5) })
        loadCatchment(stop.id)
          .then((c) => {
            const band = c.bands.at(walkMin() - 1)
            const coords = band?.coordinates.flat(2) ?? []
            if (!coords.length || selectedId() !== stop.id) {
              return
            }
            const xs = coords.map((p) => p[0])
            const ys = coords.map((p) => p[1])
            m.fitBounds(
              [
                [Math.min(...xs), Math.min(...ys)],
                [Math.max(...xs), Math.max(...ys)],
              ],
              { padding: 40, maxZoom: 16 },
            )
          })
          .catch((e: unknown) => {
            console.error(e)
          })
      }),
    )
  }

  return (
    <div
      class="map"
      ref={(el) => {
        container = el
      }}
    />
  )
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${String(c.charCodeAt(0))};`)
}
