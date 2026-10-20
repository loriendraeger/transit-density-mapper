// Load one stop's walkshed from catchments.bin: fetch the file's index once, then only
// the selected stop's bytes with an HTTP range request. Layout and encoding are written
// by pipeline/src/transit/export.py (see CATCH_FILE there).

import type { Feature, FeatureCollection, MultiPolygon, Position } from 'geojson'

import type { CatchmentIndex } from './contract'
import { dataUrl } from './data'

const FILE = 'catchments.bin'
const MAGIC = 'TDMC'
const HEADER_BYTES = 10 // magic (4) + version (u16) + index length (u32)

export interface Catchment {
  id: string
  /** Walk-network edge id -> walk time (seconds). */
  edges: Map<number, number>
  /** Band i (1-based minutes = i + 1): cumulative area, as a GeoJSON MultiPolygon. */
  bands: MultiPolygon[]
}

/** If the server ignores Range (HTTP 200), keep the whole file and slice it instead. */
let wholeFile: Promise<ArrayBuffer> | null = null

async function fetchRange(start: number, length: number): Promise<ArrayBuffer> {
  if (wholeFile) {
    return (await wholeFile).slice(start, start + length)
  }
  const res = await fetch(dataUrl(FILE), {
    headers: { Range: `bytes=${String(start)}-${String(start + length - 1)}` },
  })
  if (res.status === 206) {
    return res.arrayBuffer()
  }
  if (!res.ok) {
    throw new Error(`${FILE}: HTTP ${String(res.status)}`)
  }
  wholeFile = res.arrayBuffer()
  return (await wholeFile).slice(start, start + length)
}

let index: Promise<CatchmentIndex> | null = null

function loadIndex(): Promise<CatchmentIndex> {
  if (!index) {
    index = (async () => {
      const head = new DataView(await fetchRange(0, HEADER_BYTES))
      const magic = String.fromCharCode(...[0, 1, 2, 3].map((i) => head.getUint8(i)))
      if (magic !== MAGIC) {
        throw new Error(`${FILE}: not a catchments file`)
      }
      const length = head.getUint32(6, true)
      const json = new TextDecoder().decode(await fetchRange(HEADER_BYTES, length))
      return JSON.parse(json) as CatchmentIndex
    })()
    index.catch(() => {
      index = null
    })
  }
  return index
}

async function inflate(data: ArrayBuffer): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Reads unsigned LEB128 varints (7 bits per byte, high bit = more follow). */
class Reader {
  pos = 0
  constructor(private readonly bytes: Uint8Array) {}
  uint(): number {
    let n = 0
    let shift = 0
    for (;;) {
      const b = this.bytes[this.pos++]
      // Multiplication, not <<: values can pass 2^31.
      n += (b & 0x7f) * 2 ** shift
      if (b < 0x80) {
        return n
      }
      shift += 7
    }
  }
  /** Zigzag-decoded signed varint. */
  int(): number {
    const u = this.uint()
    return u % 2 === 0 ? u / 2 : -(u + 1) / 2
  }
  byte(): number {
    return this.bytes[this.pos++]
  }
}

export function decode(id: string, bytes: Uint8Array, idx: CatchmentIndex): Catchment {
  const r = new Reader(bytes)
  const n = r.uint()
  const ids: number[] = []
  let edgeId = 0
  for (let i = 0; i < n; i++) {
    edgeId += r.uint()
    ids.push(edgeId)
  }
  const edges = new Map<number, number>()
  for (const e of ids) {
    edges.set(e, r.byte() * idx.time_step_s)
  }
  const bands: MultiPolygon[] = []
  const nBands = r.uint()
  for (let b = 0; b < nBands; b++) {
    const polys: Position[][][] = []
    const nPolys = r.uint()
    for (let p = 0; p < nPolys; p++) {
      const rings: Position[][] = []
      const nRings = r.uint()
      for (let k = 0; k < nRings; k++) {
        const ring: Position[] = []
        const nPts = r.uint()
        let x = 0
        let y = 0
        for (let q = 0; q < nPts; q++) {
          x += r.int()
          y += r.int()
          ring.push([x / idx.scale, y / idx.scale])
        }
        rings.push(ring)
      }
      polys.push(rings)
    }
    bands.push({ type: 'MultiPolygon', coordinates: polys })
  }
  return { id, edges, bands }
}

const decoded = new Map<string, Promise<Catchment>>()

export function loadCatchment(stopId: string): Promise<Catchment> {
  let p = decoded.get(stopId)
  if (!p) {
    p = (async () => {
      const idx = await loadIndex()
      if (!(stopId in idx.stops)) {
        throw new Error(`no catchment for stop ${stopId}`)
      }
      const [offset, length] = idx.stops[stopId]
      return decode(stopId, await inflate(await fetchRange(offset, length)), idx)
    })()
    p.catch(() => decoded.delete(stopId))
    decoded.set(stopId, p)
  }
  return p
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
