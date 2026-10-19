/** A number for display: thousands separators, fixed decimals. */
export function fmt(v: number, digits = 0): string {
  return v.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

/** Compact: 1,284 -> 1.3K. */
export function compact(v: number): string {
  return v.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 })
}

/** Headway (minutes between buses) at this frequency. */
export function headwayMin(tripsPerHour: number): number | null {
  return tripsPerHour > 0 ? 60 / tripsPerHour : null
}
