# meanweather.net

**Live: <https://meanweather.net/>**

Nine global weather forecast models in one compact table. Each cell shows the **minimum, mean
and maximum** forecast across the models, one row per day, so you can see at a glance where they
agree and where they don't. Free, no account, no adverts, nothing tracked.

## What it does

- **One row per day**, expandable into hourly rows (or 3-hour blocks) with the same
  `min mean max` format. Purple outer numbers mean the models disagree by more than a threshold
  that depends on the column (4 °C for temperature, 5 mm for rain, 40 % for cloud, and so on).
- **Nine models via Open-Meteo:** ECMWF IFS, ECMWF AIFS, NOAA GFS, DWD ICON, Met Office UKMO,
  Météo-France ARPEGE, ECCC GEM, JMA and CMA GRAPES. The "seamless" variants blend each agency's
  regional high-resolution model where one exists, so the same list works worldwide. Switch any
  model off and every cell recomputes.
- **19 columns to choose from**, drag or arrow them into any order: temperature high/low,
  feels-like, rain, chance of rain, wet hours, snow, wind, wind average, gusts, wind direction
  (circular mean), cloud, humidity, dew point, pressure, sunshine, UV and a "Sky" summary
  (the most common WMO weather code, with how many models agree).
- **Trend arrows** on High, Low and Rain: whether the models' mean has moved by 1° / 1 mm since
  their run three days ago, from Open-Meteo's previous-runs archive.
- **Hover or tap any cell** for every model's value, lowest to highest. Click a column header for
  what it means.
- Place search (Photon / OpenStreetMap, with Open-Meteo's geocoder as fallback), an opt-in
  "Find me", °C/km/h/mm or °F/mph/in, and a shareable URL for any view.

## How it works

- A single static page: `index.html`, `style.css`, `app.js`. No build step, no backend, no
  analytics scripts. Everything is served behind a strict Content-Security-Policy, so there is
  no inline JavaScript or CSS.
- Three keyless, CORS-enabled Open-Meteo requests per place: daily variables (the table renders
  from this alone), hourly variables (fills the expandable rows), and the previous-runs API
  (trend arrows). All models come back in one response each.
- Aggregation is per cell across whichever models are switched on: arithmetic min/mean/max for
  numbers, a vector (circular) mean for wind direction, the mode for weather codes. In the
  3-hour view rain, snow and sunshine are summed per model and everything else averaged.
- Place, units, step, model toggles and column layout are kept in `localStorage` and mirrored
  into the URL (`?at=lat,lon&n=…&cols=…&off=…&units=…&step=…&avg=…`), so a link reproduces a view
  exactly, including which models were switched off. `tmp=1` shows a place without remembering it.
- An open tab re-fetches after an hour, or on return after 30 minutes away, and moves the
  current-hour highlight and sky theme each hour; the place line shows when the data arrived.

## Data and licences

- Forecast data: [Open-Meteo](https://open-meteo.com/), CC BY 4.0. Model coverage differs:
  precipitation probability comes from ECMWF IFS, GFS, ICON, UKMO and GEM only; gusts are not
  published by ECMWF AIFS or JMA; UV index is GFS only; sunshine is not published by JMA.
- Place search: [Photon](https://photon.komoot.io/) by komoot, data © OpenStreetMap contributors.
- Code: MIT, see `LICENSE`.

## Privacy

Two things leave your browser, both over HTTPS: the coordinates of the chosen place go to
Open-Meteo (forecast, hourly and previous-runs requests), and your search text, or your position
if you press "Find me", goes to Photon for the place lookup. Nothing else is sent anywhere. There
are no cookies, no accounts and no analytics; settings live in `localStorage` only.

## Development

Serve the folder over HTTP (for example `python -m http.server 8000`) and open
`http://localhost:8000/`. There is nothing to install or build.
