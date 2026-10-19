// Load catchments.json (every stop's walkshed) once, and decode stops on demand.

import type { Feature, FeatureCollection, MultiPolygon, Position } from 'geojson'

import type { CatchmentFile, CatchmentsFile } from './contract'
import { dataUrl } from './data'

const SCALE = 1e5

export interface Catchment {
  id: string
  /** Walk-network edge id -> walk time (seconds). */
  edges: Map<number, number>
  /** Band i (1-based minutes = i + 1): cumulative area, as a GeoJSON MultiPolygon. */
  bands: MultiPolygon[]
}

function decodeRing(flat: number[]): Position[] {
  const out: Position[] = []
  let x = 0
  let y = 0
  for (let i = 0; i + 1 < flat.length; i += 2) {
    x += flat[i]
    y += flat[i + 1]
    out.push([x / SCALE, y / SCALE])
  }
  return out
}

export function decode(id: string, file: CatchmentFile): Catchment {
  const edges = new Map<number, number>()
  let edgeId = 0
  file.edges.id_deltas.forEach((d, i) => {
    edgeId += d
    edges.set(edgeId, file.edges.t[i])
  })
  const bands = file.bands.map((polys): MultiPolygon => ({
    type: 'MultiPolygon',
    coordinates: polys.map((rings) => rings.map(decodeRing)),
  }))
  return { id, edges, bands }
}

let all: Promise<CatchmentsFile> | null = null
const decoded = new Map<string, Catchment>()

/** The whole file, fetched on first use (it's large; the map doesn't need it to start). */
function loadAll(): Promise<CatchmentsFile> {
  if (!all) {
    all = fetch(dataUrl('catchments.json')).then((res) => {
      if (!res.ok) {
        throw new Error(`catchments.json: HTTP ${String(res.status)}`)
      }
      return res.json() as Promise<CatchmentsFile>
    })
    all.catch(() => {
      all = null
    })
  }
  return all
}

export async function loadCatchment(stopId: string): Promise<Catchment> {
  const hit = decoded.get(stopId)
  if (hit) {
    return hit
  }
  const files = await loadAll()
  if (!(stopId in files)) {
    throw new Error(`no catchment for stop ${stopId}`)
  }
  const c = decode(stopId, files[stopId])
  decoded.set(stopId, c)
  return c
}

/**
 * The blob as stacked translucent bands. Bands are cumulative (band i covers everything
 * within i + 1 minutes), so a point reachable in t minutes lies under every band from
 * its own outward and their opacities compound there. Each band's opacity is solved
 * from the outside in so the compounded opacity at walk time t equals
 * maxOpacity x weights[t]: the blob fades exactly like the scoring decay.
 */
export function blobFeatures(
  c: Catchment,
  weights: number[],
  maxOpacity: number,
): FeatureCollection<MultiPolygon, { band: number; alpha: number }> {
  const target = weights.map((w) => Math.min(maxOpacity * w, 0.95))
  const features: Feature<MultiPolygon, { band: number; alpha: number }>[] = []
  for (let i = c.bands.length - 1; i >= 0; i--) {
    const here = target[i] ?? 0
    if (here <= 0) {
      continue
    }
    const outside = target[i + 1] ?? 0
    // 1 - (1 - alpha) * (1 - outside) = here
    const alpha = outside >= here ? 0.001 : 1 - (1 - here) / (1 - outside)
    features.push({
      type: 'Feature',
      properties: { band: i + 1, alpha },
      geometry: c.bands[i],
    })
  }
  return { type: 'FeatureCollection', features }
}
