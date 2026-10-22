import { For, type JSX, Show } from 'solid-js'

import { hoursLabel, PERIOD_LABELS } from '../components/Settings'
import { PERIODS } from '../lib/contract'
import { data } from '../state/store'

const PURPOSE_LABELS: Record<string, string> = {
  shop: 'shopping',
  food: 'meals',
  civic: 'errands, civic and religious',
  education: 'school and childcare',
  exercise: 'exercise',
  leisure: 'recreation (parks, venues, museums, bars)',
  health: 'health care',
  lodging: 'lodging',
}

export default function About(): JSX.Element {
  return (
    <article class="about">
      <h1>How this works</h1>
      <p class="lede">
        For every Madison Metro stop: its ridership potential (the homes, jobs and places to go
        within a short walk, and what riding from it connects to) and its transit density (how much
        is close by, and how often the bus comes). It measures where people live and go, however
        they travel today: a dense place where everyone drives is an opportunity, not low potential.
        Everything adjustable (walk limit, half-life, weights, service period) is computed in your
        browser from precomputed walking and transit travel times.
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
          <strong>Homes</strong>: residents, wherever people live, however they travel today. 2020
          Census block counts, spread over the block's parcels in proportion to dwelling units, so
          an apartment building gets more people than the houses next to it. In Madison, whose
          parcels list today's units, each block adds the units built since 2020 at the city's 2020
          persons per unit; elsewhere units are estimated (one per house, apartment buildings by
          floor area from OpenStreetMap) and the 2020 count stands.
        </li>
        <li>
          <strong>Jobs</strong>: LEHD LODES 2023 workplace counts per census block.
        </li>
        <li>
          <strong>Other destinations</strong>: OpenStreetMap places (food, shops, civic buildings,
          schools, parks, venues...) plus shops and clinics sized by their retail and health-care
          jobs (LODES), since OpenStreetMap counts a supermarket and a corner store alike. Each
          group's total follows its share of trips in the 2022 National Household Travel Survey
          (trips in urban areas):
          <Show when={data()}>
            {(d) => (
              <>
                {' '}
                {Object.entries(d().settings.purpose_shares)
                  .map(([g, v]) => `${PURPOSE_LABELS[g] ?? g} ${String(Math.round(v * 100))} %`)
                  .join(', ')}
                .
              </>
            )}
          </Show>{' '}
          Within a group, places are weighted by kind (a supermarket more than a convenience store;
          parks by area). Large places count from their nearest edge.
        </li>
      </ul>

      <h2>Score</h2>
      <Show when={data()}>
        {(d) => (
          <p>
            Four components. Homes, jobs and other destinations are each summed over everything
            within the walk limit (by default {d().settings.score.walk_min} minutes), each counted
            less the farther it is (its weight halves every half-life, by default{' '}
            {d().settings.score.half_life_min} minutes). Transit connections count what riding from
            the stop reaches (below). Each component is scaled 0–100 against the best stop, and the
            score is their weighted average; the default weights (homes{' '}
            {d().settings.score.weights.pop}, jobs {d().settings.score.weights.jobs}, other
            destinations {d().settings.score.weights.dest}, transit connections{' '}
            {d().settings.score.weights.transit}) are fit to ridership, below. People and places
            within reach of several stops count for each of them, so scores compare stops' potential
            rather than counting riders.
          </p>
        )}
      </Show>

      <h2>Transit connections</h2>
      <Show when={data()}>
        {(d) => (
          <p>
            What a stop connects to by riding: travel times from every stop to every 150 m hex,
            walking and riding with transfers, for every departure minute from{' '}
            {d().settings.score.access.departure_hour} to{' '}
            {d().settings.score.access.departure_hour + d().settings.score.access.window_hours} am
            on a weekday (computed with R5, the routing engine behind Conveyal). A rider who shows
            up at random waits about half the time between buses; one who plans around the schedule
            barely waits, so the score uses the {d().settings.score.access.percentile}th-percentile
            trip, which predicted ridership best. Jobs and destinations reached count less the
            longer the trip (halving every {d().settings.score.access.half_life_min} minutes, none
            past {d().settings.score.access.max_minutes}).{' '}
            {d().settings.score.access.dest_weight < 0.01
              ? 'In practice the fit counts jobs reached: destinations reached add nothing beyond them, since the two go together. '
              : d().settings.score.access.jobs_weight < 0.01
                ? 'In practice the fit counts destinations reached: jobs reached add nothing beyond them. '
                : ''}
            Adding transit connections raised how much of the variation in boardings per trip the
            model explains from {Math.round(d().settings.fit.walk_only_cv_r2 * 100)} % to{' '}
            {Math.round(d().settings.fit.cv_r2 * 100)} % (cross-validated). Each stop's details also
            show residents who can get to it by transit, and the map can shade its transit reach.
          </p>
        )}
      </Show>

      <h2>Overlap with neighbors</h2>
      <p>
        The score counts everyone within reach of a stop, so people near several stops count for
        each. <strong>What it adds over neighbors</strong> (a stop color option and in each stop's
        details) asks the stop-consolidation question instead: for each home, job and destination,
        how much closer is this stop than the nearest other stop on the same routes? A stop whose
        neighbors are nearly as close adds little; the only stop for a neighborhood adds a lot.
        Sharing each place among all the stops that reach it (so the totals add up) was tested too,
        but it predicted ridership worse, likely because stops on different routes serve different
        trips; the score keeps counting catchments in full.
      </p>

      <h2>Fit to ridership</h2>
      <Show when={data()?.settings.fit}>
        {(f) => (
          <>
            <p>
              The default weights come from weekday boardings at each stop (Greater Madison MPO,
              February 2024, estimated from farebox and bus-location records). Boardings depend
              heavily on how often the bus comes, so the fit uses <em>boardings per trip</em>: the
              score's own formula (a weighted sum of the catchment totals, plus a constant) fit on a
              log scale. This is a simple form of the <em>direct ridership model</em> transit
              agencies use. The same data chose how destinations are counted: trip-purpose shares
              and sizing shops and clinics by jobs both predicted ridership better than hand-set
              weights.
            </p>
            <p>
              The fit explains {Math.round(f().cv_r2 * 100)} % of the variation in boardings per
              trip across {f().n_fit} stops (cross-validated): the catchment matters, but most of
              what makes a stop busy is elsewhere, above all where its buses go. Schools, campus,
              park-and-rides, the airport and transfer points (5+ routes) draw riders a walkshed
              can't see, so they were left out of the fit. The default assumption (a 10-minute walk,
              halving every 4 minutes) follows planning convention; the data favor shorter walks,
              which the <em>Best fit</em> button applies with weights refit for it.
            </p>
            <p>
              <strong>Riders vs. expected</strong> (a stop color option) divides each stop's
              boardings by the fit's expectation from its catchment, transit connections and
              service. Far fewer riders than expected can mean a stop crowded by a neighbor, a route
              that goes nowhere useful, or a barrier the walk model misses; far more, a draw the
              catchment doesn't count. Caveats: the ridership predates the BRT (September 2024), so
              the BRT stations, likely sited where the old Route A's riders already were, sit far
              above expectations; and service has partly gone where riders already were, so
              frequency also stands in for demand.
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
        OpenStreetMap contributors. Transit routing with R5 (Conveyal) via r5py. Code GPL-3.0; data
        outputs ODbL. A for-fun project, not affiliated with Metro Transit.
      </p>
    </article>
  )
}
