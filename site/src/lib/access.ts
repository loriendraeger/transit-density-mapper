// One stop's transit travel times to every hex it reaches (access.bin, written by
// pipeline/src/transit/export.py access_bin): for the transit isochrone. A record is n,
// then n hex id deltas (ascending), then n bytes of minutes.

import { dataUrl } from './data'
import { IndexedFile, Reader } from './indexed'

interface AccessIndex {
  version: number
  percentile: number
  stops: Record<string, [number, number]>
}

const file = new IndexedFile<AccessIndex>(() => dataUrl('access.bin'), 'access.bin', 'TDMA')
const decoded = new Map<string, Promise<Map<number, number>>>()

/** Hex id -> travel time (minutes) by transit from the stop. */
export function loadAccess(stopId: string): Promise<Map<number, number>> {
  let p = decoded.get(stopId)
  if (!p) {
    p = (async () => {
      const bytes = await file.record(stopId)
      const out = new Map<number, number>()
      if (!bytes) {
        return out
      }
      const r = new Reader(bytes)
      const n = r.uint()
      const ids: number[] = []
      let id = 0
      for (let i = 0; i < n; i++) {
        id += r.uint()
        ids.push(id)
      }
      for (const h of ids) {
        out.set(h, r.byte())
      }
      return out
    })()
    p.catch(() => decoded.delete(stopId))
    decoded.set(stopId, p)
  }
  return p
}
