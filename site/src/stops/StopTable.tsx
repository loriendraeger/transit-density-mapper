import {
  createColumnHelper,
  createSortedRowModel,
  createTable,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  type SortingState,
  tableFeatures,
} from '@tanstack/solid-table'
import { createMemo, createSignal, For, type JSX } from 'solid-js'

import { RouteChip } from '../components/StopDetail'
import type { Route } from '../lib/contract'
import type { Scored } from '../lib/scoring'
import { fmt } from '../lib/units'
import { model } from '../state/store'

const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, basic: sortFn_basic },
})
const helper = createColumnHelper<typeof features, Scored>()

const TEXT_COLUMNS = new Set(['name', 'routes'])

export default function StopTable(props: {
  rows: Scored[]
  routes: Map<string, Route>
  selectedId: string | null
  onSelect: (id: string) => void
}): JSX.Element {
  const [sorting, setSorting] = createSignal<SortingState>([{ id: 'score', desc: true }])
  const columns = helper.columns([
    helper.accessor('rank', { id: 'rank', header: '#', sortFn: 'basic' }),
    helper.accessor((s) => s.stop.name, {
      id: 'name',
      header: 'Stop',
      sortFn: 'alphanumeric',
      cell: (c) => (
        <span>
          {c.getValue()}
          <span class="muted"> · {c.row.original.stop.codes.join(', ')}</span>
        </span>
      ),
    }),
    helper.accessor((s) => s.stop.routes.length, {
      id: 'routes',
      header: 'Routes',
      sortFn: 'basic',
      cell: (c) => (
        <span class="chips">
          <For each={c.row.original.stop.routes}>
            {(id) => <RouteChip id={id} route={props.routes.get(id)} />}
          </For>
        </span>
      ),
    }),
    // Score and its parts: trip ends a day (potential) or 0-100 (tuned). The rows are
    // rescored when the model changes, so the accessors rerun.
    helper.accessor('score', {
      id: 'score',
      header: () => (model() === 'potential' ? 'Potential' : 'Score'),
      sortFn: 'basic',
      cell: (c) => fmt(c.getValue(), 0),
    }),
    helper.accessor((s) => (model() === 'potential' ? s.trips.pop : s.norm.pop), {
      id: 'pop',
      header: 'Homes',
      sortFn: 'basic',
      cell: (c) => fmt(c.getValue(), 0),
    }),
    helper.accessor((s) => (model() === 'potential' ? s.trips.jobs : s.norm.jobs), {
      id: 'jobs',
      header: 'Jobs',
      sortFn: 'basic',
      cell: (c) => fmt(c.getValue(), 0),
    }),
    helper.accessor((s) => (model() === 'potential' ? s.trips.dest : s.norm.dest), {
      id: 'dest',
      header: 'Other dest.',
      sortFn: 'basic',
      cell: (c) => fmt(c.getValue(), 0),
    }),
    helper.accessor((s) => s.norm.transit, {
      id: 'transit',
      header: 'Transit',
      sortFn: 'basic',
      cell: (c) => fmt(c.getValue(), 0),
    }),
    helper.accessor('freq', {
      id: 'freq',
      header: 'Trips/h',
      sortFn: 'basic',
      cell: (c) => fmt(c.getValue(), 1),
    }),
    helper.accessor((s) => s.perBus ?? undefined, {
      id: 'perbus',
      header: 'Per bus',
      sortFn: 'basic',
      sortUndefined: 'last',
      cell: (c) => {
        const v = c.getValue()
        return v === undefined ? '–' : `×${fmt(v, v < 10 ? 1 : 0)}`
      },
    }),
    helper.accessor((s) => s.adds ?? undefined, {
      id: 'adds',
      header: 'Adds',
      sortFn: 'basic',
      sortUndefined: 'last',
      cell: (c) => {
        const v = c.getValue()
        return v === undefined ? '–' : `${fmt(v * 100, 0)} %`
      },
    }),
    // Stops without ridership data show a dash and sort last either way.
    helper.accessor((s) => s.riders ?? undefined, {
      id: 'riders',
      header: 'Riders ÷ exp.',
      sortFn: 'basic',
      sortUndefined: 'last',
      cell: (c) => {
        const v = c.getValue()
        return v === undefined ? '–' : `×${fmt(v, v < 10 ? 2 : 0)}`
      },
    }),
  ])

  const table = createTable({
    features,
    columns,
    get data() {
      return props.rows
    },
    get state() {
      return { sorting: sorting() }
    },
    onSortingChange: (u) => {
      setSorting(typeof u === 'function' ? u(sorting()) : u)
    },
  })
  const rows = createMemo(() => table.getRowModel().rows)

  return (
    <div class="table-wrap">
      <table class="stops">
        <thead>
          <For each={table.getHeaderGroups()}>
            {(group) => (
              <tr>
                <For each={group.headers}>
                  {(header) => {
                    function sorted(): false | 'asc' | 'desc' {
                      return header.column.getIsSorted()
                    }
                    return (
                      <th
                        classList={{ num: !TEXT_COLUMNS.has(header.column.id) }}
                        aria-sort={
                          sorted() === 'asc'
                            ? 'ascending'
                            : sorted() === 'desc'
                              ? 'descending'
                              : 'none'
                        }
                      >
                        <button onClick={header.column.getToggleSortingHandler()}>
                          <table.FlexRender header={header} />
                          <span class="sort" aria-hidden="true">
                            {sorted() === 'asc' ? '▲' : sorted() === 'desc' ? '▼' : ''}
                          </span>
                        </button>
                      </th>
                    )
                  }}
                </For>
              </tr>
            )}
          </For>
        </thead>
        <tbody>
          <For each={rows()}>
            {(row) => (
              <tr
                classList={{ selected: row.original.stop.id === props.selectedId }}
                onClick={() => {
                  props.onSelect(row.original.stop.id)
                }}
              >
                <For each={row.getAllCells()}>
                  {(cell) => (
                    <td
                      classList={{
                        num: !TEXT_COLUMNS.has(cell.column.id),
                        routes: cell.column.id === 'routes',
                      }}
                    >
                      <table.FlexRender cell={cell} />
                    </td>
                  )}
                </For>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  )
}
