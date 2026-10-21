import { For, type JSX, Show } from 'solid-js'

import { hoursLabel, PERIOD_LABELS } from '../components/Settings'
import { PERIODS } from '../lib/contract'
import { data } from '../state/store'

export default function About(): JSX.Element {
  return (
    <article class="about">
      <h1>How this works</h1>
      <p class="lede">
        For every Madison Metro stop: who lives and works within a short walk, what there is to walk
        to, and how often the bus comes. Everything adjustable (walk time, decay, weights, service
        period) is computed in your browser from precomputed walk times.
      </p>

      <h2>Stops</h2>
      <p>
        Stops come from Metro's GTFS schedule. Platforms that serve the same place are merged: BRT
        platforms of one station always, and any group of stops that all lie within{' '}
        {data()?.settings.cluster_max_diameter_m ?? 110} m of each other (complete-linkage
        clustering, so a chain of stops along a street doesn't merge into one). E Washington &amp;
        North and W Johnson &amp; East Campus Mall are typical merges: local and BRT stops at one
        corner. A merged stop sits at the middle of its platforms.
      </p>

      <h2>Frequency</h2>
      <p>
        Departures you can board, all routes together, on one representative date per day type (the
        most common weekly pattern in the feed):
      </p>
      <Show when={data()}>
        {(d) => (
          <ul>
            <For each={PERIODS}>
              {(p) => (
                <li>
                  {PERIOD_LABELS[p]}: {hoursLabel(d().settings.periods[p].hours)} (
                  {d().rep_dates[d().settings.periods[p].day_type]})
                </li>
              )}
            </For>
          </ul>
        )}
      </Show>
      <p>
        Trips per hour = departures in the period ÷ its hours. The weighted week averages the
        periods by the hours each stands for. Frequency is per direction, since a rider boards one
        way: a merged stop usually holds both sides of the street, so each route counts the average
        of the directions it runs there (GTFS <code>direction_id</code>), and the routes add up. One
        side of a one-way pair (Johnson/Gorham) or the end of a line sees one direction only, so it
        counts in full.
      </p>

      <h2>Walking</h2>
      <p>
        Walk times come from OpenStreetMap's sidewalks, paths and streets, at{' '}
        {data()?.settings.walk_speed_mps ?? 1.3} m/s, computed with pgRouting from every stop out to{' '}
        {data()?.settings.max_walk_min ?? 20} minutes. Big streets are barriers: trunk, primary and
        secondary roads can only be crossed at a signal or a marked crosswalk, and crossing costs
        the expected wait (about half the signal's red: 30–45 s at signals, 10–30 s at marked
        crossings, halved per side of a divided road) plus the walk across. Elsewhere walks detour
        to the nearest allowed crossing. Turn on “Arterial crossings” under Layers to see them.
      </p>
      <p>
        On the map, the selected stop's spiderweb shows every walkable path in reach, fading with
        walk time, and the blob summarizes it: its opacity at each point follows the same decay
        curve as the score.
      </p>

      <h2>What's in reach</h2>
      <ul>
        <li>
          <strong>Population</strong>: 2020 Census block counts, spread over the block's parcels in
          proportion to dwelling units, so an apartment building gets more people than the houses
          next to it. City of Madison parcels list their units; elsewhere units are estimated (one
          per house, apartment buildings by floor area from OpenStreetMap). Changes since 2020
          aren't reflected.
        </li>
        <li>
          <strong>Jobs</strong>: LEHD LODES 2023 workplace counts per census block.
        </li>
        <li>
          <strong>Destinations</strong>: OpenStreetMap places in categories (food, nightlife,
          venues, culture, parks, grocery, health, education...), each weighted by kind: a café 1, a
          supermarket 5, a hospital or the zoo 10; parks scale with their area. Large places count
          from their nearest edge.
        </li>
      </ul>

      <h2>Score</h2>
      <p>
        Each of population, jobs and destinations is summed over the walkshed with the decay weight
        of its walk time, then scaled 0–100 against the best stop. The score is their weighted
        average. Everything inside the walk-time limit counts; nothing beyond it. People and places
        within reach of several stops count for each of them.
      </p>

      <h2>Checked against ridership</h2>
      <Show when={data()?.settings.fit}>
        {(f) => (
          <>
            <p>
              The default weights are guesses. To test them, the score is compared with weekday
              boardings at each stop (Greater Madison MPO, February 2024, estimated from farebox and
              bus-location records). Boardings depend heavily on how often the bus comes, so the fit
              uses <em>boardings per trip</em>: the score's own formula (a weighted sum of the
              catchment totals, plus a constant) fit on a log scale, with the decay half-life and
              walk limit searched minute by minute. This is a simple form of the{' '}
              <em>direct ridership model</em> transit agencies use.
            </p>
            <p>
              Best fit: population {f().weights.pop}, jobs {f().weights.jobs}, destinations{' '}
              {f().weights.dest}, a {f().walk_min}-minute walk limit and a {f().decay.param}
              -minute half-life. It explains {Math.round(f().cv_r2 * 100)} % of the variation in
              boardings per trip across {f().n_fit} stops (cross-validated): the catchment matters,
              but most of what makes a stop busy is elsewhere, above all where its buses go.
              Schools, campus, park-and-rides, the airport and transfer points (5+ routes) draw
              riders a walkshed can't see, so they were left out of the fit.
            </p>
            <p>
              <strong>Riders vs. expected</strong> (a stop color option) divides each stop's
              boardings by the fit's expectation from its catchment and service. Far fewer riders
              than expected can mean a stop crowded by a neighbor, a route that goes nowhere useful,
              or a barrier the walk model misses; far more, a draw the catchment doesn't count.
              Caveats: the ridership predates the BRT (September 2024), and service has partly gone
              where riders already were, so frequency also stands in for demand.
            </p>
          </>
        )}
      </Show>

      <h2>Sources</h2>
      <Show when={data()}>
        {(d) => (
          <ul>
            <For each={Object.values(d().sources)}>
              {(s) => (
                <li>
                  <a href={s.url}>{s.name}</a> (retrieved {s.retrieved})
                  <Show when={s.attribution}>. {s.attribution}</Show>
                </li>
              )}
            </For>
          </ul>
        )}
      </Show>
      <p class="fine">
        Data provided under license granted by City of Madison, WI, Metro Transit. Map data ©
        OpenStreetMap contributors. Code GPL-3.0; data outputs ODbL. A for-fun project, not
        affiliated with Metro Transit.
      </p>
    </article>
  )
}
