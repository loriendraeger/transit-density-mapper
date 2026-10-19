# AGENTS.md

Guidance for AI coding agents (and humans) working in this repo.

## The Project

The goal here is to create a map of transit trip generators and transit stops. I also want to make a 'Stop Analysis' tab on the site that has an entry for each stop, its frequencies throughout the day, and some sort of score for trip generators in its catchment area.

This is a project for fun that will be hosted on GitHub pages.

### Trip Generators

Census data for population is definitely in play. I'm wondering if we can refine it more granularly than the census track level by looking at tax parcel data and making some guesses about what block people live on based on number of dwelling units. If the same census track has a block full of single family homes and a big apartment building, I'd like to guess that more people live in the apartment building.

I'd also like to grab job density. No idea where I can find this. Census data? Propose suggestions.

If possible I want to flag cultural things, too: concert venues, zoos, botanical gardens, bars, restaurants. Propose suggestions.

I want to make some decisions for how to weight these, but I want the user to be able to tinker with them in terms of the scoring and how the map looks, if possible.

### Stops

Transit stop data will come from Madison Metro.

- Schedule data: http://transitdata.cityofmadison.com/GTFS/
- License for data: https://www.cityofmadison.com/metro/business/information-for-developers/developer-license-agreement-and-terms-of-use

Challenge: I'm not sure how clean the data is. I want to merge very nearby stops (e.g. The A and B stops near E Washington Ave and North St intersection). Precise location of the merged stop can be a midpoint.

I want to define the catchment area in terms of walking time. I want to use OpenStreetMap data to draw a little spiderweb of walking paths out from the transit stop based on walking time. On the map and in the analysis users should be able to select how much walking time is acceptable (5 to 20 minute slider). Really this is a distance measurement, but I want to penalize big street crossings, assuming the rider has to wait for the stoplight. Propose some options for how to do this. Then I want a blob that summarizes the spiderweb with a gradient that gets more transparent as the walking time grows.

## Tech Stack

To start, steal from ../public-private-shore. Definitely make suggestions for changes based on the requirements.