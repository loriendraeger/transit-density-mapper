import type { StopsFile } from './contract'

/** Absolute URL of a file in public/data/ (the site is served under a base path). */
export function dataUrl(file: string): string {
  return new URL(`${import.meta.env.BASE_URL}data/${file}`, window.location.href).href
}

export async function loadStops(): Promise<StopsFile> {
  const res = await fetch(dataUrl('stops.json'))
  if (!res.ok) {
    throw new Error(`stops.json: HTTP ${String(res.status)}`)
  }
  return (await res.json()) as StopsFile
}
