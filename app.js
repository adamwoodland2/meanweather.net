/* meanweather.net — multi-model forecast table.
 *
 * Three keyless, CORS-enabled Open-Meteo requests per place:
 *   1. daily variables for every model  -> the table renders from this alone (fast first paint)
 *   2. hourly variables for every model -> fills the expandable hour rows (+ is_day for night shading)
 *   3. previous-runs API                 -> what each model said 1, 2 and 3 days ago, for the drift arrows
 * Each cell shows min / mean / max across whichever models are switched on (circular mean for wind
 * direction, most-common answer for the weather code). Hover a cell for a tooltip, or tap/click it
 * for the same breakdown in a popover (touch devices have no hover).
 *
 * All the "_seamless" models blend in that agency's regional high-resolution model where one
 * exists, so the same nine sources work anywhere in the world.
 *
 * Everything runs in the browser; place, units, step, source and column choices live in
 * localStorage and are mirrored into the URL so a view can be shared.
 */

(function () {
  'use strict';

  var LS_KEY = 'cw-v3';
  var DAYS = 10;
  var API = 'https://api.open-meteo.com/v1/forecast';
  var PREV_API = 'https://previous-runs-api.open-meteo.com/v1/forecast';
  var LAGS = [1, 2, 3];          // days ago, for the drift comparison
  var MIN_HOURS = 20;            // hours a previous run must cover before its day value counts

  var MODELS = [
    { id: 'ecmwf_ifs025',         name: 'ECMWF IFS',   org: 'Europe',
      full: 'Integrated Forecasting System (IFS), 0.25° global model — European Centre for Medium-Range Weather Forecasts' },
    { id: 'ecmwf_aifs025_single', name: 'ECMWF AIFS',  org: 'Europe, AI',
      full: 'Artificial Intelligence Forecasting System (AIFS Single), 0.25° machine-learning model — European Centre for Medium-Range Weather Forecasts' },
    { id: 'gfs_seamless',         name: 'GFS',         org: 'NOAA, US',
      full: 'Global Forecast System — NOAA National Weather Service, USA. Seamless: HRRR and NBM blended in over North America' },
    { id: 'icon_seamless',        name: 'ICON',        org: 'DWD, Germany',
      full: 'Icosahedral Nonhydrostatic model — Deutscher Wetterdienst, Germany. Seamless: ICON-EU and ICON-D2 blended in over Europe and Germany' },
    { id: 'ukmo_seamless',        name: 'UKMO',        org: 'Met Office, UK',
      full: 'Unified Model, global deterministic — UK Met Office. Seamless: UKV 2 km blended in over the British Isles' },
    { id: 'meteofrance_seamless', name: 'ARPEGE',      org: 'Météo-France',
      full: 'Action de Recherche Petite Échelle Grande Échelle (ARPEGE) — Météo-France. Seamless: AROME 1.5 km blended in over France' },
    { id: 'gem_seamless',         name: 'GEM',         org: 'ECCC, Canada',
      full: 'Global Environmental Multiscale model (GDPS) — Environment and Climate Change Canada. Seamless: RDPS and HRDPS blended in over Canada' },
    { id: 'jma_seamless',         name: 'JMA',         org: 'Japan',
      full: 'Global Spectral Model (GSM) — Japan Meteorological Agency. Seamless: MSM 5 km blended in over Japan' },
    { id: 'cma_grapes_global',    name: 'CMA GRAPES',  org: 'China',
      full: 'Global/Regional Assimilation and Prediction System (GRAPES), global — China Meteorological Administration' }
  ];
  var MODEL = {};
  MODELS.forEach(function (m) { MODEL[m.id] = m; });

  /* ---------------- column catalogue ----------------
   * kind   -> unit, formatter and CSS class (see KINDS). `hkind` overrides it for hour rows.
   * wide   -> min–max spread that flags disagreement, in the metric unit Open-Meteo returns
   *           (°C, mm, cm, km/h, %, hPa, seconds); scaled by KINDS[kind].scale for imperial.
   * hwide  -> the same for hour rows, when a different threshold makes sense.
   * drift  -> {agg, thr}: how to fold a previous run's hours into a day value, and the change
   *           in the models' mean (metric units) that earns an arrow.
   * desc   -> the header tooltip and the Columns panel text.
   */
  function round(v) { return String(Math.round(v)); }

  var KINDS = {
    temp:   { cls: 'deg', sign: '°', scale: 1.8,      agg: 'mean', unit: function (imp) { return imp ? '°F' : '°C'; }, fmt: round },
    precip: { cls: 'mm',  sign: '',  scale: 1 / 25.4, agg: 'sum',  unit: function (imp) { return imp ? 'in' : 'mm'; },
              fmt: function (v, imp) { return imp ? (v < 1 ? v.toFixed(2) : v.toFixed(1)) : (v < 10 ? v.toFixed(1) : round(v)); } },
    snow:   { cls: 'mm',  sign: '',  scale: 1 / 2.54, agg: 'sum',  unit: function (imp) { return imp ? 'in' : 'cm'; }, fmt: function (v) { return v.toFixed(1); } },
    pct:    { cls: 'pct', sign: '',  scale: 1,        agg: 'mean', unit: function () { return '%'; }, fmt: round },
    hours:  { cls: 'pct', sign: '',  scale: 1,        agg: 'mean', unit: function () { return 'h'; }, fmt: round },
    speed:  { cls: 'spd', sign: '',  scale: 0.6214,   agg: 'mean', unit: function (imp) { return imp ? 'mph' : 'km/h'; }, fmt: round },
    hpa:    { cls: 'hpa', sign: '',  scale: 1,        agg: 'mean', unit: function () { return 'hPa'; }, fmt: round },
    sunH:   { cls: 'sun', sign: '',  scale: 1,        agg: 'sum',  unit: function () { return 'h'; }, fmt: function (v) { return (v / 3600).toFixed(1); } },
    sunMin: { cls: 'sun', sign: '',  scale: 1,        agg: 'sum',  unit: function () { return 'min'; }, fmt: function (v) { return round(v / 60); } },
    uv:     { cls: 'pct', sign: '',  scale: 1,        agg: 'mean', unit: function () { return 'index'; }, fmt: function (v) { return v.toFixed(1); } },
    dir:    { cls: 'dir', circular: true, agg: 'dir', unit: function () { return 'from'; } },
    code:   { cls: 'code', categorical: true, agg: 'mode', unit: function () { return ''; } }
  };

  var COLUMNS = [
    { key: 'high',      label: 'High',       kind: 'temp',   daily: 'temperature_2m_max',            hourly: 'temperature_2m',            wide: 4,
      drift: { agg: 'max', thr: 1 },
      desc: 'Highest air temperature of the day, 2 m above ground. Hour rows show the temperature for that hour. The small arrow shows whether the models’ mean has moved by 1° or more since their run three days ago.' },
    { key: 'low',       label: 'Low',        kind: 'temp',   daily: 'temperature_2m_min',            hourly: 'temperature_2m',            wide: 4,
      drift: { agg: 'min', thr: 1 },
      desc: 'Lowest air temperature of the day, 2 m above ground. Hour rows show the temperature for that hour. The small arrow shows whether the models’ mean has moved by 1° or more since their run three days ago.' },
    { key: 'feelsHigh', label: 'Feels high', kind: 'temp',   daily: 'apparent_temperature_max',      hourly: 'apparent_temperature',      wide: 4,
      desc: 'Highest "feels like" temperature: air temperature adjusted for humidity, wind and sunshine.' },
    { key: 'feelsLow',  label: 'Feels low',  kind: 'temp',   daily: 'apparent_temperature_min',      hourly: 'apparent_temperature',      wide: 4,
      desc: 'Lowest "feels like" temperature: air temperature adjusted for humidity, wind and sunshine.' },
    { key: 'rain',      label: 'Rain',       kind: 'precip', daily: 'precipitation_sum',             hourly: 'precipitation',             wide: 5, hwide: 2,
      drift: { agg: 'sum', thr: 1 },
      desc: 'Total precipitation for the day: rain, showers and melted snow. Hour rows show the amount falling in that hour. The small arrow shows whether the models’ mean has moved by 1 mm or more since their run three days ago.' },
    { key: 'pop',       label: 'Chance',     kind: 'pct',    daily: 'precipitation_probability_max', hourly: 'precipitation_probability', wide: 40,
      desc: 'Chance of at least 0.1 mm of precipitation in an hour, from each model’s ensemble spread. The day value is the wettest hour’s chance. Only ECMWF IFS, GFS, ICON, UKMO and GEM publish it.' },
    { key: 'wetHours',  label: 'Wet hours',  kind: 'hours',  daily: 'precipitation_hours',           hourly: null,                        wide: 4,
      desc: 'Number of hours in the day with measurable precipitation. Day rows only.' },
    { key: 'snow',      label: 'Snow',       kind: 'snow',   daily: 'snowfall_sum',                  hourly: 'snowfall',                  wide: 3, hwide: 1,
      desc: 'Snowfall depth for the day, about 7× the water equivalent.' },
    { key: 'wind',      label: 'Wind',       kind: 'speed',  daily: 'wind_speed_10m_max',            hourly: 'wind_speed_10m',            wide: 15,
      desc: 'Highest sustained wind speed of the day at 10 m (10-minute average, not gusts).' },
    { key: 'windMean',  label: 'Wind avg',   kind: 'speed',  daily: 'wind_speed_10m_mean',           hourly: 'wind_speed_10m',            wide: 15,
      desc: 'Average sustained wind speed over the day at 10 m.' },
    { key: 'gust',      label: 'Gusts',      kind: 'speed',  daily: 'wind_gusts_10m_max',            hourly: 'wind_gusts_10m',            wide: 20,
      desc: 'Strongest gust of the day at 10 m. Not published by ECMWF AIFS or JMA.' },
    { key: 'windDir',   label: 'Wind dir',   kind: 'dir',    daily: 'wind_direction_10m_dominant',   hourly: 'wind_direction_10m',        wide: 90,
      desc: 'Direction the wind blows from. Middle: circular mean of the models. Outer: the most anticlockwise and clockwise models. Purple when they span 90° or more.' },
    { key: 'cloud',     label: 'Cloud',      kind: 'pct',    daily: 'cloud_cover_mean',              hourly: 'cloud_cover',               wide: 40,
      desc: 'Total cloud cover as a share of the sky, averaged over the day.' },
    { key: 'humidity',  label: 'Humidity',   kind: 'pct',    daily: 'relative_humidity_2m_mean',     hourly: 'relative_humidity_2m',      wide: 25,
      desc: 'Relative humidity at 2 m, averaged over the day.' },
    { key: 'dew',       label: 'Dew point',  kind: 'temp',   daily: 'dew_point_2m_mean',             hourly: 'dew_point_2m',              wide: 4,
      desc: 'Dew point at 2 m, averaged over the day. Above about 18 °C (64 °F) feels muggy.' },
    { key: 'pressure',  label: 'Pressure',   kind: 'hpa',    daily: 'pressure_msl_mean',             hourly: 'pressure_msl',              wide: 6,
      desc: 'Atmospheric pressure reduced to sea level, averaged over the day.' },
    { key: 'sun',       label: 'Sunshine',   kind: 'sunH',   hkind: 'sunMin', daily: 'sunshine_duration', hourly: 'sunshine_duration',   wide: 10800, hwide: 1800,
      desc: 'Hours of direct sunshine in the day (minutes in the hour rows). Not published by JMA.' },
    { key: 'uv',        label: 'UV',         kind: 'uv',     daily: 'uv_index_max',                  hourly: 'uv_index',                  wide: 3,
      desc: 'Peak clear-sky UV index. GFS is the only model that publishes it, so there is no spread.' },
    { key: 'sky',       label: 'Sky',        kind: 'code',   daily: 'weather_code',                  hourly: 'weather_code',
      desc: 'The most common weather summary across the models (WMO code); the day value is each model’s most severe hour. Hover or tap for what every model says.' }
  ];
  var COL = {};
  COLUMNS.forEach(function (c) { COL[c.key] = c; });
  var DEFAULT_COLS = ['high', 'low', 'rain', 'pop', 'wind', 'sky'];
  var DAILY_VARS = uniq(COLUMNS.map(function (c) { return c.daily; }));
  var HOURLY_VARS = uniq(COLUMNS.map(function (c) { return c.hourly; }));
  var HKIND = {};   // hourly variable -> kind name (for 3-hour aggregation)
  COLUMNS.forEach(function (c) { if (c.hourly && !HKIND[c.hourly]) HKIND[c.hourly] = c.hkind || c.kind; });
  // amounts can come back a hair negative from Open-Meteo's interpolation of accumulated fields
  var CLAMP0 = {};
  COLUMNS.forEach(function (c) {
    if (c.kind === 'precip' || c.kind === 'snow') { CLAMP0[c.daily] = true; if (c.hourly) CLAMP0[c.hourly] = true; }
  });
  function clean(v, name) { return CLAMP0[name] && v < 0 ? 0 : v; }

  var COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  var WMO = {
    0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Rime fog',
    51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle',
    61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain',
    71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
    80: 'Light showers', 81: 'Showers', 82: 'Heavy showers', 85: 'Snow showers', 86: 'Snow showers',
    95: 'Thunderstorm', 96: 'Thunder, hail', 99: 'Thunder, hail'
  };

  var DEFAULT_PLACE = { name: 'Sydney', where: 'New South Wales, Australia', lat: -33.8688, lon: 151.2093 };

  var MAX_PLACES = 10;       // recent-places tabs kept

  var state = {
    place: null,          // the active entry of `places`
    places: [],           // [{name, where, lat, lon, used}] in the order added
    units: 'metric',      // 'metric' | 'imperial'
    step: 3,              // hours per row when a day is expanded: 3 (default) or 1
    avg: 'mean',          // the middle number: 'mean' | 'median' (saved + in the URL)
    mode: 'colour',       // 'colour' (theme follows the current sky) | 'dark' (saved, not in the URL)
    enabled: {},          // model id -> boolean
    cols: [],             // [{key, on}] in display order
    data: null,           // see normaliseDaily(); hours + prev attached later
    hourlyReady: false,
    prevReady: false,
    open: {},             // date -> boolean (expanded)
    token: 0              // bumps on every refresh; stale responses are dropped
  };

  var $ = function (sel) { return document.querySelector(sel); };
  function imperial() { return state.units === 'imperial'; }
  function visibleCols() {
    return state.cols.filter(function (c) { return c.on; }).map(function (c) { return COL[c.key]; });
  }
  function uniq(arr) {
    var out = [];
    arr.forEach(function (x) { if (x && out.indexOf(x) < 0) out.push(x); });
    return out;
  }

  /* ---------------- recent places ---------------- */

  function samePlace(a, b) {
    return Math.abs(a.lat - b.lat) < 0.0005 && Math.abs(a.lon - b.lon) < 0.0005;
  }

  // add (or touch) a place in the tab list and return the stored entry
  function rememberPlace(p) {
    var hit = state.places.filter(function (x) { return samePlace(x, p); })[0];
    if (hit) {
      hit.used = Date.now();
      if (p.name && p.name !== 'Your location') { hit.name = p.name; hit.where = p.where || hit.where; }
      return hit;
    }
    var entry = { name: p.name || '', where: p.where || '', lat: +p.lat, lon: +p.lon, used: Date.now() };
    state.places.push(entry);
    while (state.places.length > MAX_PLACES) {
      var oldest = null;
      state.places.forEach(function (x) { if (x !== entry && (!oldest || x.used < oldest.used)) oldest = x; });
      state.places.splice(state.places.indexOf(oldest), 1);
    }
    return entry;
  }

  function forgetPlace(i) {
    var gone = state.places[i];
    if (!gone) return;
    state.places.splice(i, 1);
    if (gone === state.place) {
      var next = state.places[i - 1] || state.places[i] || null;
      if (next) { setPlace(next); return; }   // saves + refreshes
      // nothing left: keep showing the current forecast, the tab strip just empties
      save();
      renderTabs();
      return;
    }
    save();
    renderTabs();
  }

  /* ---------------- persistence + URL ---------------- */

  function defaultCols() {
    return COLUMNS.map(function (c) { return { key: c.key, on: DEFAULT_COLS.indexOf(c.key) >= 0 }; });
  }

  function colsFromKeys(keys) {
    var seen = {}, out = [];
    keys.forEach(function (k) { if (COL[k] && !seen[k]) { seen[k] = true; out.push({ key: k, on: true }); } });
    COLUMNS.forEach(function (c) { if (!seen[c.key]) out.push({ key: c.key, on: false }); });
    return out;
  }

  function load() {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (e) { saved = null; }
    saved = saved || {};
    state.places = (saved.places || []).filter(function (p) {
      return p && isFinite(+p.lat) && isFinite(+p.lon);
    }).map(function (p) {
      return { name: p.name || '', where: p.where || '', lat: +p.lat, lon: +p.lon, used: +p.used || 0 };
    });
    state.place = null;
    if (saved.place && isFinite(+saved.place.lat)) {
      state.place = state.places.filter(function (p) { return samePlace(p, saved.place); })[0] || null;
      if (!state.place) { state.place = rememberPlace(saved.place); }
    }
    state.units = saved.units === 'imperial' ? 'imperial' : 'metric';
    state.step = saved.step === 1 ? 1 : 3;
    state.avg = saved.avg === 'median' ? 'median' : 'mean';
    state.mode = saved.mode === 'dark' ? 'dark' : 'colour';
    MODELS.forEach(function (m) {
      state.enabled[m.id] = !(saved.enabled && saved.enabled[m.id] === false);
    });
    var seen = {};
    state.cols = [];
    (saved.cols || []).forEach(function (c) {
      if (COL[c.key] && !seen[c.key]) { seen[c.key] = true; state.cols.push({ key: c.key, on: !!c.on }); }
    });
    COLUMNS.forEach(function (c) {
      if (!seen[c.key]) state.cols.push({ key: c.key, on: !saved.cols && DEFAULT_COLS.indexOf(c.key) >= 0 });
    });

    // a shared link overrides the saved view
    var q = new URLSearchParams(location.search);
    var at = (q.get('at') || '').split(',');
    if (at.length === 2 && isFinite(+at[0]) && isFinite(+at[1])) {
      state.place = rememberPlace({ name: q.get('n') || (+at[0]).toFixed(2) + ', ' + (+at[1]).toFixed(2), where: q.get('w') || '', lat: +at[0], lon: +at[1] });
    }
    if (q.get('units') === 'imperial' || q.get('units') === 'metric') state.units = q.get('units');
    if (q.get('step') === '3' || q.get('step') === '1') state.step = +q.get('step');
    if (q.get('avg') === 'median' || q.get('avg') === 'mean') state.avg = q.get('avg');
    if (q.get('cols')) state.cols = colsFromKeys(q.get('cols').split(','));
  }

  function save() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        place: state.place, places: state.places,
        units: state.units, step: state.step, avg: state.avg, mode: state.mode,
        enabled: state.enabled, cols: state.cols
      }));
    } catch (e) { /* private mode etc. — fine */ }
    syncUrl();
  }

  function syncUrl() {
    if (!state.place) return;
    var q = new URLSearchParams();
    q.set('at', state.place.lat.toFixed(4) + ',' + state.place.lon.toFixed(4));
    if (state.place.name) q.set('n', state.place.name);
    if (state.place.where) q.set('w', state.place.where);
    var vis = state.cols.filter(function (c) { return c.on; }).map(function (c) { return c.key; });
    if (vis.join(',') !== DEFAULT_COLS.join(',')) q.set('cols', vis.join(','));
    if (imperial()) q.set('units', 'imperial');
    if (state.step === 1) q.set('step', '1');
    if (state.avg === 'median') q.set('avg', 'median');
    try { history.replaceState(null, '', location.pathname + '?' + q.toString()); } catch (e) { /* file:// etc. */ }
  }

  /* ---------------- fetching ---------------- */

  function baseUrl(api, place) {
    var u = new URL(api);
    u.searchParams.set('latitude', place.lat);
    u.searchParams.set('longitude', place.lon);
    u.searchParams.set('timezone', 'auto');
    u.searchParams.set('forecast_days', String(DAYS));
    u.searchParams.set('models', MODELS.map(function (m) { return m.id; }).join(','));
    if (imperial()) {
      u.searchParams.set('temperature_unit', 'fahrenheit');
      u.searchParams.set('wind_speed_unit', 'mph');
      u.searchParams.set('precipitation_unit', 'inch');
    }
    return u;
  }

  function getJson(u, what) {
    return fetch(u.toString()).then(function (r) {
      if (!r.ok) throw new Error(what + ' answered ' + r.status);
      return r.json();
    });
  }

  function fetchDaily(place) {
    var u = baseUrl(API, place);
    u.searchParams.set('daily', DAILY_VARS.join(','));
    return getJson(u, 'Open-Meteo');
  }

  function fetchHourly(place) {
    var u = baseUrl(API, place);
    u.searchParams.set('hourly', HOURLY_VARS.concat(['is_day']).join(','));
    return getJson(u, 'Open-Meteo hourly');
  }

  function fetchPrev(place) {
    var vars = [];
    uniq(COLUMNS.filter(function (c) { return c.drift; }).map(function (c) { return c.hourly; })).forEach(function (v) {
      vars.push(v);
      LAGS.forEach(function (l) { vars.push(v + '_previous_day' + l); });
    });
    var u = baseUrl(PREV_API, place);
    u.searchParams.set('hourly', vars.join(','));
    return getJson(u, 'Previous runs');
  }

  /* Place search: Photon (OpenStreetMap) first, Open-Meteo's GeoNames geocoder as fallback. */

  function geocodeOpenMeteo(q) {
    var u = new URL('https://geocoding-api.open-meteo.com/v1/search');
    u.searchParams.set('name', q);
    u.searchParams.set('count', '8');
    u.searchParams.set('language', 'en');
    u.searchParams.set('format', 'json');
    return getJson(u, 'Geocoder').then(function (j) {
      return (j.results || []).map(function (r) {
        var where = [r.admin1, r.country].filter(Boolean).join(', ');
        return { name: r.name, where: where, type: '', lat: r.latitude, lon: r.longitude };
      });
    });
  }

  function photonPlace(f) {
    var p = f.properties || {};
    var name = p.name || [p.housenumber, p.street].filter(Boolean).join(' ') || p.city || p.state || p.country || '?';
    var where = [];
    [p.district, p.locality, p.city, p.county, p.state, p.country].forEach(function (x) {
      if (x && x !== name && where.indexOf(x) < 0) where.push(x);
    });
    var type = (p.osm_value || '');
    if (type === 'yes' || type === 'administrative') type = p.type === 'house' ? 'address' : (p.osm_key || '');
    type = type.replace(/_/g, ' ');
    return {
      name: name, where: where.join(', '), type: type,
      lat: +f.geometry.coordinates[1].toFixed(4), lon: +f.geometry.coordinates[0].toFixed(4)
    };
  }

  function geocodePhoton(q) {
    var u = new URL('https://photon.komoot.io/api/');
    u.searchParams.set('q', q);
    u.searchParams.set('limit', '10');
    u.searchParams.set('lang', 'en');
    return getJson(u, 'Photon').then(function (j) {
      var seen = {}, out = [];
      (j.features || []).forEach(function (f) {
        var p = photonPlace(f);
        var k = (p.name + '|' + p.where).toLowerCase();
        if (!seen[k]) { seen[k] = true; out.push(p); }
      });
      return out.slice(0, 8);
    });
  }

  function geocode(q) {
    return geocodePhoton(q).then(function (list) {
      return list.length ? list : geocodeOpenMeteo(q);
    }, function () {
      return geocodeOpenMeteo(q);
    });
  }

  function reverseGeocode(lat, lon) {
    var u = new URL('https://photon.komoot.io/reverse');
    u.searchParams.set('lat', lat);
    u.searchParams.set('lon', lon);
    u.searchParams.set('lang', 'en');
    return fetch(u.toString()).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
      var f = j && j.features && j.features[0];
      if (!f) return null;
      var p = f.properties || {};
      var name = p.district || p.locality || p.city || p.county || p.name || null;
      if (!name) return null;
      var where = [p.city, p.state, p.country].filter(function (x) { return x && x !== name; }).join(', ');
      return { name: name, where: where };
    }).catch(function () { return null; });
  }

  // First visit, no permission prompt: guess a starting city from the browser's IANA zone.
  function guessPlace() {
    var zone = '';
    try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { zone = ''; }
    var city = zone.split('/').pop().replace(/_/g, ' ');
    if (!city || zone.indexOf('/') < 0 || /^(Etc|UTC|GMT)/.test(zone)) return Promise.resolve(DEFAULT_PLACE);
    return geocodeOpenMeteo(city).then(function (list) { return list[0] || DEFAULT_PLACE; }, function () { return DEFAULT_PLACE; });
  }

  /* ---------------- normalise ----------------
   * data.days[i] = { date, vals: {dailyVar: {modelId: v}}, hours: [{time, night, vals: {hourlyVar: {modelId: v}}}],
   *                  prev: {colKey: {lag: {modelId: dayValue}}} }
   */
  function normaliseDaily(j) {
    var d = j.daily;
    var days = d.time.map(function (date) {
      var day = { date: date, vals: {}, hours: [], prev: {} };
      DAILY_VARS.forEach(function (v) { day.vals[v] = {}; });
      return day;
    });
    DAILY_VARS.forEach(function (v) {
      MODELS.forEach(function (m) {
        var arr = d[v + '_' + m.id] || [];
        days.forEach(function (day, i) { if (arr[i] != null) day.vals[v][m.id] = clean(arr[i], v); });
      });
    });
    var horizon = {};
    MODELS.forEach(function (m) {
      horizon[m.id] = days.filter(function (day) { return m.id in day.vals.temperature_2m_max; }).length;
    });
    return { tz: j.timezone, tzAbbr: j.timezone_abbreviation, elevation: j.elevation, days: days, horizon: horizon };
  }

  function attachHourly(j) {
    var h = j.hourly, byDate = {};
    state.data.days.forEach(function (day) { byDate[day.date] = day; day.hours = []; });
    var dayKeys = MODELS.map(function (m) { return 'is_day_' + m.id; }).filter(function (k) { return h[k]; });
    h.time.forEach(function (t, i) {
      var day = byDate[t.slice(0, 10)];
      if (!day) return;
      var hour = { time: t, night: false, vals: {} };
      for (var k = 0; k < dayKeys.length; k++) {
        var v = h[dayKeys[k]][i];
        if (v != null) { hour.night = v === 0; break; }
      }
      HOURLY_VARS.forEach(function (v) {
        hour.vals[v] = {};
        MODELS.forEach(function (m) {
          var x = (h[v + '_' + m.id] || [])[i];
          if (x != null) hour.vals[v][m.id] = clean(x, v);
        });
      });
      day.hours.push(hour);
    });
  }

  // fold previous-run hours into per-day values: prev[colKey][lag][modelId]
  function attachPrev(j) {
    var h = j.hourly, idx = {};
    state.data.days.forEach(function (day, i) { idx[day.date] = i; day.prev = {}; });
    COLUMNS.filter(function (c) { return c.drift; }).forEach(function (c) {
      var lags = [0].concat(LAGS);
      state.data.days.forEach(function (day) {
        day.prev[c.key] = {};
        lags.forEach(function (l) { day.prev[c.key][l] = {}; });
      });
      lags.forEach(function (l) {
        MODELS.forEach(function (m) {
          var arr = h[c.hourly + (l ? '_previous_day' + l : '') + '_' + m.id];
          if (!arr) return;
          var acc = {};
          h.time.forEach(function (t, i) {
            var v = arr[i];
            if (v == null) return;
            v = clean(v, c.hourly);
            var d = t.slice(0, 10);
            var a = acc[d] || (acc[d] = { n: 0, sum: 0, min: Infinity, max: -Infinity });
            a.n++; a.sum += v;
            if (v < a.min) a.min = v;
            if (v > a.max) a.max = v;
          });
          Object.keys(acc).forEach(function (d) {
            var a = acc[d];
            if (a.n < MIN_HOURS || !(d in idx)) return;
            var val = c.drift.agg === 'max' ? a.max : c.drift.agg === 'min' ? a.min : a.sum;
            state.data.days[idx[d]].prev[c.key][l][m.id] = val;
          });
        });
      });
    });
  }

  /* ---------------- aggregate ---------------- */

  function collect(values) {
    var per = [];
    if (values) {
      MODELS.forEach(function (m) {
        if (state.enabled[m.id] && m.id in values) per.push({ model: m, v: values[m.id] });
      });
    }
    return per;
  }

  function median(arr) {
    var s = arr.slice().sort(function (a, b) { return a - b; });
    var m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  // the "middle number": mean or median of the models, per the toolbar switch
  function avgOf(arr) {
    if (state.avg === 'median') return median(arr);
    return arr.reduce(function (a, b) { return a + b; }, 0) / arr.length;
  }

  function numStat(per) {
    var min = Infinity, max = -Infinity;
    per.forEach(function (p) {
      if (p.v < min) min = p.v;
      if (p.v > max) max = p.v;
    });
    return { min: min, max: max, mean: avgOf(per.map(function (p) { return p.v; })), spread: max - min };
  }

  function circMean(vals) {
    var sx = 0, sy = 0;
    vals.forEach(function (v) { sx += Math.cos(v * Math.PI / 180); sy += Math.sin(v * Math.PI / 180); });
    return (Math.atan2(sy, sx) * 180 / Math.PI + 360) % 360;
  }

  // wind direction: vector mean, then the most anticlockwise / clockwise model relative to it
  function dirStat(per) {
    var mean = circMean(per.map(function (p) { return p.v; }));
    var lo = 0, hi = 0;
    per.forEach(function (p) {
      var off = ((p.v - mean + 540) % 360) - 180;
      if (off < lo) lo = off;
      if (off > hi) hi = off;
    });
    return { min: (mean + lo + 360) % 360, max: (mean + hi + 360) % 360, mean: mean, spread: hi - lo };
  }

  function mode(vals) {
    var count = {}, best = null;
    vals.forEach(function (v) {
      count[v] = (count[v] || 0) + 1;
      if (best === null || count[v] > count[best] || (count[v] === count[best] && v > best)) best = v;
    });
    return { value: best, agree: count[best] };
  }

  function compass(deg) { return COMPASS[Math.round(deg / 22.5) % 16]; }
  function wmo(code) { return WMO[code] || ('Code ' + code); }
  function enabledCount() { return MODELS.filter(function (m) { return state.enabled[m.id]; }).length; }

  // one model's values over a block of hours -> one value, by kind
  function foldBlock(vals, kindName) {
    var agg = KINDS[kindName].agg;
    if (agg === 'sum') return vals.reduce(function (a, b) { return a + b; }, 0);
    if (agg === 'dir') return circMean(vals);
    if (agg === 'mode') return mode(vals).value;
    return vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
  }

  // the rows shown under a day: one per hour, or one per 3-hour block (values folded per model)
  function blocksFor(day) {
    if (state.step === 1) {
      return day.hours.map(function (h) {
        return { label: h.time.slice(11, 16), start: h.time.slice(0, 13), end: h.time.slice(0, 13), night: h.night, vals: h.vals };
      });
    }
    var blocks = [];
    for (var i = 0; i < day.hours.length; i += 3) {
      var hs = day.hours.slice(i, i + 3), vals = {}, nights = 0;
      hs.forEach(function (h) { if (h.night) nights++; });
      HOURLY_VARS.forEach(function (v) {
        vals[v] = {};
        MODELS.forEach(function (m) {
          var xs = [];
          hs.forEach(function (h) { if (m.id in h.vals[v]) xs.push(h.vals[v][m.id]); });
          if (xs.length === hs.length) vals[v][m.id] = foldBlock(xs, HKIND[v]);
        });
      });
      var h0 = hs[0].time.slice(11, 13), h1 = String((+hs[hs.length - 1].time.slice(11, 13) + 1) % 24);
      blocks.push({
        label: h0 + '–' + (h1.length < 2 ? '0' + h1 : h1),
        start: hs[0].time.slice(0, 13), end: hs[hs.length - 1].time.slice(0, 13),
        night: nights * 2 > hs.length, vals: vals
      });
    }
    return blocks;
  }

  // drift of the models' mean for one day + column: oldest lag that still covers the day
  function driftFor(day, col) {
    var p = day.prev && day.prev[col.key];
    if (!p) return null;
    for (var i = LAGS.length - 1; i >= 0; i--) {
      var lag = LAGS[i], from = [], to = [];
      MODELS.forEach(function (m) {
        if (state.enabled[m.id] && m.id in p[lag] && m.id in p[0]) { from.push(p[lag][m.id]); to.push(p[0][m.id]); }
      });
      if (from.length >= 2) {
        var f = avgOf(from), t = avgOf(to);
        var thr = col.drift.thr * (imperial() ? KINDS[col.kind].scale : 1);
        return { lag: lag, from: f, to: t, delta: t - f, n: from.length, dir: t - f >= thr ? 'up' : f - t >= thr ? 'down' : '' };
      }
    }
    return null;
  }

  /* ---------------- time helpers ---------------- */

  function nowKey(tz) {
    try {
      var parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit'
      }).formatToParts(new Date());
      var p = {};
      parts.forEach(function (x) { p[x.type] = x.value; });
      if (p.hour === '24') p.hour = '00';
      return p.year + '-' + p.month + '-' + p.day + 'T' + p.hour;
    } catch (e) {
      return '';
    }
  }

  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function dayLabel(date) {
    var y = +date.slice(0, 4), m = +date.slice(5, 7) - 1, d = +date.slice(8, 10);
    var dt = new Date(Date.UTC(y, m, d));
    return { dow: DOW[dt.getUTCDay()], dt: d + ' ' + MON[m] };
  }

  /* ---------------- describe a cell (shared by tooltip and popover) ---------------- */

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function signed(kind, v, imp) {
    var s = kind.fmt(Math.abs(v), imp);
    return (v < 0 ? '−' : '+') + s + (kind.sign || '');
  }

  // -> { kind, per, n, lo, mean, hi, wide, zero, rows: [{model, text}], code?, agree?, drift? }
  function describe(col, values, hourly, day) {
    var kind = KINDS[hourly && col.hkind ? col.hkind : col.kind];
    var per = collect(values);
    var out = { kind: kind, per: per, n: per.length, N: enabledCount(), rows: [] };
    if (!per.length) return out;
    var imp = imperial();

    if (kind.categorical) {
      var cs = mode(per.map(function (p) { return p.v; }));
      out.code = cs.value; out.agree = cs.agree;
      out.wide = cs.agree * 2 < per.length;
      out.rows = per.slice().sort(function (a, b) { return a.v - b.v; })
        .map(function (p) { return { model: p.model, text: wmo(p.v) }; });
      return out;
    }
    var s;
    if (kind.circular) {
      s = dirStat(per);
      out.lo = compass(s.min); out.mean = compass(s.mean); out.hi = compass(s.max);
      out.wide = col.wide != null && s.spread >= col.wide;
      out.rows = per.slice().sort(function (a, b) {
        return (((a.v - s.mean + 540) % 360) - 180) - (((b.v - s.mean + 540) % 360) - 180);
      }).map(function (p) { return { model: p.model, text: compass(p.v) + ' ' + Math.round(p.v) + '°' }; });
    } else {
      s = numStat(per);
      out.lo = kind.fmt(s.min, imp); out.mean = kind.fmt(s.mean, imp); out.hi = kind.fmt(s.max, imp);
      var thr = hourly && col.hwide != null ? col.hwide : col.wide;
      out.wide = thr != null && s.spread >= thr * (imp ? kind.scale : 1);
      out.zero = s.max === 0 && s.min === 0;
      out.rows = per.slice().sort(function (a, b) { return a.v - b.v; })
        .map(function (p) { return { model: p.model, text: kind.fmt(p.v, imp) + (kind.sign || ' ' + kind.unit(imp)) }; });
      if (!hourly && col.drift && day) out.drift = driftFor(day, col);
    }
    return out;
  }

  // one decimal for the trend, so a sub-degree shift does not read as "22 -> 22 (+1)"
  function fine(kind, v, imp) {
    if (kind.cls === 'deg') return v.toFixed(1) + kind.sign;
    return kind.fmt(v, imp) + (kind.sign || '');
  }

  function driftText(col, dr) {
    var kind = KINDS[col.kind], imp = imperial();
    if (!dr) return state.prevReady ? 'No earlier run reaches this day yet.' : '';
    var what = dr.lag + ' day' + (dr.lag > 1 ? 's' : '') + ' ago';
    var d = dr.delta, sign = d < 0 ? '−' : '+';
    return 'Trend: ' + what + ' the models’ ' + state.avg + ' was ' + fine(kind, dr.from, imp) +
      ', now ' + fine(kind, dr.to, imp) + ' (' + sign + fine(kind, Math.abs(d), imp) + ', ' + dr.n + ' models).';
  }

  function tooltip(col, d) {
    if (!d.n) return '';
    var lines = [d.n + ' of ' + d.N + ' sources'].concat(d.rows.map(function (r) { return r.model.name + ' ' + r.text; }));
    if (d.drift !== undefined) {
      var t = driftText(col, d.drift);
      if (t) lines.push('', t);
    }
    return lines.join('\n');
  }

  /* ---------------- render: cells ---------------- */

  // `ref` = data attributes locating the cell's data for the popover
  function cell(col, values, hourly, span, ref, day) {
    var d = describe(col, values, hourly, day);
    var kind = d.kind;
    var attrs = (span > 1 ? ' colspan="' + span + '"' : '') + ref;
    if (!d.n) return '<td class="stat none ' + kind.cls + '"' + attrs + '>—</td>';
    var cls = 'stat ' + kind.cls + (d.wide ? ' wide' : '') + (d.zero ? ' zero' : '');
    var title = ' title="' + esc(tooltip(col, d)) + '"';

    if (kind.categorical) {
      return '<td class="' + cls + '"' + title + attrs + '><span class="mean">' + esc(wmo(d.code)) +
        '</span><span class="agree">' + d.agree + '/' + d.n + '</span></td>';
    }
    var drift = '';
    if (!hourly && col.drift) {
      var dr = d.drift;
      drift = '<span class="drift' + (dr && dr.dir ? ' ' + dr.dir : '') + '" aria-hidden="true">' +
        (dr && dr.dir ? (dr.dir === 'up' ? '▲' : '▼') : '') + '</span>';
    }
    return '<td class="' + cls + '"' + title + attrs + '>' +
      '<span class="lo">' + d.lo + '</span>' +
      '<span class="mean">' + d.mean + (kind.sign || '') + '</span>' +
      '<span class="hi">' + d.hi + '</span>' + drift + '</td>';
  }

  /* ---------------- render: table ---------------- */

  function renderHead() {
    var tr = $('#fcTable thead tr');
    tr.textContent = '';
    var th = document.createElement('th');
    th.className = 'when'; th.scope = 'col'; th.textContent = 'Day';
    tr.appendChild(th);
    visibleCols().forEach(function (c) {
      var kind = KINDS[c.kind];
      var t = document.createElement('th');
      t.scope = 'col';
      t.title = c.desc;
      t.dataset.c = c.key;
      var lbl = document.createElement('span');
      lbl.className = 'lbl';
      lbl.textContent = c.label;
      t.appendChild(lbl);
      var unit = kind.unit(imperial());
      if (unit) {
        var s = document.createElement('small');
        s.textContent = unit;
        t.appendChild(document.createTextNode(' '));
        t.appendChild(s);
      }
      tr.appendChild(t);
    });
  }

  function renderTable() {
    var table = $('#fcTable');
    Array.prototype.slice.call(table.tBodies).forEach(function (b) { b.remove(); });
    if (!state.data) return;

    var cols = visibleCols();
    var now = nowKey(state.data.tz);
    var today = now.slice(0, 10);
    var html = '', shown = 0, opened = 0;

    state.data.days.forEach(function (day, di) {
      if (!collect(day.vals.temperature_2m_max).length) return;  // beyond every enabled model
      var lbl = dayLabel(day.date);
      var rel = day.date === today ? 'Today' : (di === 1 && state.data.days[0].date === today ? 'Tomorrow' : '');
      var open = !!state.open[day.date];
      shown++; if (open) opened++;

      html += '<tbody class="day' + (open ? ' open' : '') + '" data-date="' + day.date + '">';
      html += '<tr class="d">' +
        '<td class="when"><button class="tog" type="button" aria-expanded="' + open + '">' +
        '<span class="chev" aria-hidden="true"></span>' +
        (rel ? '<span class="rel">' + rel + '</span> ' : '<span class="dow">' + lbl.dow + '</span> ') +
        '<span class="dt">' + lbl.dt + '</span></button></td>';
      cols.forEach(function (c) {
        html += cell(c, day.vals[c.daily], false, 1, ' data-d="' + di + '" data-c="' + c.key + '"', day);
      });
      html += '</tr>';

      if (!open) { html += '</tbody>'; return; }   // hour rows are built only for open days

      if (!day.hours.length) {
        html += '<tr class="h note"><td class="when"></td><td colspan="' + cols.length + '">' +
          (state.hourlyReady ? 'No hourly data for this day.' : 'Loading hourly detail…') + '</td></tr></tbody>';
        return;
      }
      var blocks = blocksFor(day);
      day.blocks = blocks;
      blocks.forEach(function (b, bi) {
        var cls = 'h' + (b.end < now ? ' past' : (b.start <= now && now <= b.end) ? ' now' : '') + (b.night ? ' night' : '');
        html += '<tr class="' + cls + '"><td class="when">' + b.label + '</td>';
        for (var i = 0; i < cols.length;) {
          var c = cols[i], span = 1;
          while (c.hourly && cols[i + span] && cols[i + span].hourly === c.hourly &&
                 (cols[i + span].hkind || cols[i + span].kind) === (c.hkind || c.kind)) span++;
          html += c.hourly
            ? cell(c, b.vals[c.hourly], true, span, ' data-d="' + di + '" data-h="' + bi + '" data-c="' + c.key + '"')
            : '<td class="stat blank"></td>';
          i += span;
        }
        html += '</tr>';
      });
      html += '</tbody>';
    });

    table.insertAdjacentHTML('beforeend', html);
    var btn = $('#expandAll');
    btn.textContent = shown && opened === shown ? 'Collapse all' : 'Expand all';
    btn.disabled = !shown;
  }

  /* ---------------- render: popover ---------------- */

  var pop = null, popAnchor = null;

  function closePop() {
    if (pop) { pop.hidden = true; popAnchor = null; }
  }

  function openPop(anchor, build) {
    if (!pop) pop = $('#pop');
    if (popAnchor === anchor) { closePop(); return; }
    pop.textContent = '';
    build(pop);
    pop.hidden = false;
    popAnchor = anchor;
    var r = anchor.getBoundingClientRect();
    var w = pop.offsetWidth, vw = document.documentElement.clientWidth;
    var left = Math.max(8, Math.min(r.left + window.scrollX, window.scrollX + vw - w - 8));
    pop.style.left = left + 'px';
    pop.style.top = (r.bottom + window.scrollY + 6) + 'px';
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function popForCell(td) {
    var col = COL[td.dataset.c];
    var day = state.data.days[+td.dataset.d];
    var hourly = 'h' in td.dataset, values, when;
    if (hourly) {
      var b = (day.blocks || blocksFor(day))[+td.dataset.h];
      if (!b) return;
      values = b.vals[col.hourly];
      when = b.label + (state.step === 3 ? ' (3-hour block)' : '');
    } else {
      values = day.vals[col.daily];
      when = dayLabel(day.date).dow + ' ' + dayLabel(day.date).dt;
    }
    var d = describe(col, values, hourly, day);
    openPop(td, function (box) {
      var kind = d.kind;
      var h = el('h4', null, (hourly && col.hourly === 'temperature_2m' ? 'Temperature' : col.label) + ' · ' + when);
      box.appendChild(h);
      if (!d.n) { box.appendChild(el('p', 'n', 'No model has a value here.')); return; }
      var sum = el('p', 'n');
      if (kind.categorical) sum.textContent = d.agree + ' of ' + d.n + ' models say ' + wmo(d.code) + '.';
      else sum.textContent = 'min ' + d.lo + ' · ' + state.avg + ' ' + d.mean + (kind.sign || '') + ' · max ' + d.hi +
        (kind.sign ? '' : ' ' + kind.unit(imperial())) + ' · ' + d.n + ' of ' + d.N + ' sources';
      box.appendChild(sum);
      var ul = el('ul');
      d.rows.forEach(function (r) {
        var li = el('li', 'm-' + r.model.id);
        li.appendChild(el('span', 'dot'));
        var nm = el('span', 'name', r.model.name);
        nm.title = r.model.full;
        li.appendChild(nm);
        li.appendChild(el('span', 'val', r.text));
        ul.appendChild(li);
      });
      box.appendChild(ul);
      if (d.drift !== undefined) {
        var t = driftText(col, d.drift);
        if (t) box.appendChild(el('p', 'trend', t));
      }
    });
  }

  function popForHead(th) {
    var col = COL[th.dataset.c];
    openPop(th, function (box) {
      var unit = KINDS[col.kind].unit(imperial());
      box.appendChild(el('h4', null, col.label + (unit ? ' · ' + unit : '')));
      box.appendChild(el('p', 'n', col.desc));
      box.appendChild(el('p', 'trend', 'Cells read min · ' + state.avg + ' · max across the models; purple outer numbers mean they disagree.'));
    });
  }

  /* ---------------- render: chrome ---------------- */

  function renderSources() {
    var ul = $('#sourceList');
    ul.textContent = '';
    MODELS.forEach(function (m) {
      var li = el('li', 'm-' + m.id);
      var label = el('label');
      var cb = el('input');
      cb.type = 'checkbox';
      cb.checked = !!state.enabled[m.id];
      cb.dataset.model = m.id;
      label.appendChild(cb);
      label.appendChild(el('span', 'dot'));
      label.title = m.full;
      label.appendChild(el('span', 'name', m.name));
      label.appendChild(el('span', 'org', m.org));
      if (state.data) {
        var days = state.data.horizon[m.id];
        label.appendChild(days ? el('span', 'days', days + 'd') : el('span', 'off', 'no data'));
      }
      li.appendChild(label);
      ul.appendChild(li);
    });
    $('#srcCount').textContent = enabledCount() + ' of ' + MODELS.length;
  }

  function renderColumns() {
    var ol = $('#colList');
    ol.textContent = '';
    state.cols.forEach(function (entry, idx) {
      var c = COL[entry.key];
      var li = el('li');
      li.dataset.key = c.key;
      li.draggable = true;
      var grip = el('span', 'grip', '⠇');
      grip.setAttribute('aria-hidden', 'true');
      var label = el('label');
      var cb = el('input');
      cb.type = 'checkbox'; cb.checked = entry.on; cb.dataset.col = c.key;
      label.appendChild(cb);
      label.appendChild(el('span', 'name', c.label));
      label.appendChild(el('span', 'unit', KINDS[c.kind].unit(imperial())));
      label.appendChild(el('span', 'desc', c.desc));
      var up = el('button', 'mv', '▲');
      up.type = 'button'; up.dataset.move = '-1'; up.title = 'Move up'; up.disabled = idx === 0;
      var down = el('button', 'mv', '▼');
      down.type = 'button'; down.dataset.move = '1'; down.title = 'Move down'; down.disabled = idx === state.cols.length - 1;
      li.appendChild(grip); li.appendChild(label); li.appendChild(up); li.appendChild(down);
      ol.appendChild(li);
    });
    $('#colCount').textContent = visibleCols().length + ' of ' + COLUMNS.length;
  }

  function renderSeg(sel, attr, value) {
    Array.prototype.forEach.call(document.querySelectorAll(sel + ' button'), function (b) {
      b.setAttribute('aria-pressed', String(b.dataset[attr] === String(value)));
    });
  }

  function renderAvg() {
    renderSeg('#avg', 'avg', state.avg);
    var k = $('.k.mean');
    if (k) k.textContent = state.avg;
  }

  /* ---------------- theme ----------------
   * Colour mode: the page background follows the current hour's sky at the chosen place
   * (html[data-sky], html[data-night]); before the hourly data lands, today's daily code and a
   * clock heuristic stand in; before any data, the neutral default look. Dark mode: plain black.
   */
  function skyClass(code) {
    if (code == null) return '';
    if (code <= 1) return 'clear';
    if (code === 2) return 'partly';
    if (code === 3) return 'overcast';
    if (code === 45 || code === 48) return 'fog';
    if (code >= 95) return 'storm';
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
    if (code >= 51) return 'rain';
    return '';
  }

  function currentSky() {
    if (!state.data) return null;
    var now = nowKey(state.data.tz), today = now.slice(0, 10);
    var day = null, hour = null;
    state.data.days.forEach(function (d) { if (d.date === today) day = d; });
    if (!day) day = state.data.days[0];
    if (!day) return null;
    day.hours.forEach(function (h) { if (h.time.slice(0, 13) === now) hour = h; });
    var per = collect(hour ? hour.vals.weather_code : day.vals.weather_code);
    var code = per.length ? mode(per.map(function (p) { return p.v; })).value : null;
    var night;
    if (hour) night = hour.night;
    else { var hh = +now.slice(11, 13); night = hh < 6 || hh >= 18; }
    return { sky: skyClass(code), night: night };
  }

  function applyTheme() {
    var root = document.documentElement;
    if (state.mode === 'dark') {
      root.setAttribute('data-mode', 'dark');
      root.removeAttribute('data-sky');
      root.removeAttribute('data-night');
    } else {
      root.removeAttribute('data-mode');
      var s = currentSky();
      if (s && s.sky) root.setAttribute('data-sky', s.sky); else root.removeAttribute('data-sky');
      if (s && s.night) root.setAttribute('data-night', '1'); else root.removeAttribute('data-night');
    }
    var meta = $('meta[name="theme-color"]');
    if (meta) {
      var bg = getComputedStyle(root).getPropertyValue('--bg').trim();
      if (bg) meta.setAttribute('content', bg);
    }
    renderSeg('#mode', 'mode', state.mode);
  }

  function renderTabs() {
    var nav = $('#tabs');
    nav.textContent = '';
    nav.hidden = !state.places.length;
    state.places.forEach(function (p, i) {
      var tab = el('div', 'tab' + (p === state.place ? ' on' : ''));
      var go = el('button', 'go', p.name || (p.lat.toFixed(2) + ', ' + p.lon.toFixed(2)));
      go.type = 'button';
      go.dataset.i = i;
      go.title = p.where ? p.where : '';
      if (p === state.place) go.setAttribute('aria-current', 'true');
      var x = el('button', 'x', '×');
      x.type = 'button';
      x.dataset.x = i;
      x.title = 'Remove ' + (p.name || 'this place') + ' from the list';
      x.setAttribute('aria-label', x.title);
      tab.appendChild(go); tab.appendChild(x);
      nav.appendChild(tab);
    });
  }

  function renderPlace() {
    renderTabs();
    $('#placeName').textContent = state.place.name;
    var bits = [], full = [];
    if (state.place.where) bits.push(state.place.where);
    full.push(state.place.lat.toFixed(4) + ', ' + state.place.lon.toFixed(4));
    if (state.data) {
      bits.push(state.data.tzAbbr);
      full.push(state.data.tz);
      if (state.data.elevation != null) bits.push(Math.round(state.data.elevation) + ' m');
    }
    var meta = $('#placeMeta');
    meta.textContent = bits.join(' · ');
    meta.title = full.join(' · ');
  }

  function setStatus(msg, err) {
    var e = $('#status');
    e.textContent = msg || '';
    e.className = 'status' + (err ? ' err' : '');
  }

  function loadingStatus() {
    if (!state.data) return;
    var waiting = [];
    if (!state.hourlyReady) waiting.push('hourly detail');
    if (!state.prevReady) waiting.push('trend');
    setStatus(waiting.length ? 'Loading ' + waiting.join(' and ') + '…' : '');
  }

  /* ---------------- actions ---------------- */

  function refresh() {
    var token = ++state.token;
    var place = state.place;
    closePop();
    setStatus('Fetching ' + MODELS.length + ' models…');
    renderPlace();
    state.data = null;
    state.hourlyReady = state.prevReady = false;
    renderTable();
    applyTheme();   // back to the neutral look while the new place loads

    fetchDaily(place).then(function (j) {
      if (token !== state.token) return;
      state.data = normaliseDaily(j);
      renderPlace();
      renderSources();
      renderHead();
      renderTable();
      applyTheme();   // today's sky, day/night from the clock
      loadingStatus();

      fetchHourly(place).then(function (jh) {
        if (token !== state.token) return;
        attachHourly(jh);
        state.hourlyReady = true;
        renderTable();
        applyTheme();   // refine to the current hour's sky and real day/night
        loadingStatus();
      }).catch(function (e) {
        if (token !== state.token) return;
        state.hourlyReady = true;
        setStatus('Hourly detail unavailable: ' + e.message, true);
      });

      fetchPrev(place).then(function (jp) {
        if (token !== state.token) return;
        attachPrev(jp);
        state.prevReady = true;
        renderTable();
        loadingStatus();
      }).catch(function () {
        if (token !== state.token) return;
        state.prevReady = true;   // no arrows, but nothing else is lost
        loadingStatus();
      });
    }).catch(function (e) {
      if (token !== state.token) return;
      setStatus('Could not load the forecast: ' + e.message, true);
    });
  }

  // make `p` the active place (adding it to the tabs if new) and load its forecast
  function setPlace(p) {
    state.place = rememberPlace(p);
    state.open = {};
    save();
    refresh();
    return state.place;
  }

  function applyColumns() {
    save();
    renderColumns();
    renderHead();
    renderTable();
  }

  function moveCol(key, delta) {
    var i = state.cols.findIndex(function (c) { return c.key === key; });
    var j = i + delta;
    if (i < 0 || j < 0 || j >= state.cols.length) return;
    var tmp = state.cols[i]; state.cols[i] = state.cols[j]; state.cols[j] = tmp;
    applyColumns();
  }

  function toggleDay(body, open) {
    var date = body.dataset.date;
    state.open[date] = open;
    renderTable();   // hour rows are built lazily, so re-render rather than toggle a class
  }

  function showResults(list) {
    var ul = $('#locResults');
    ul.textContent = '';
    if (!list.length) ul.appendChild(el('li', 'empty', 'No places found'));
    list.forEach(function (p) {
      var li = el('li');
      var b = el('button', null, p.name);
      b.type = 'button';
      if (p.type) b.appendChild(el('span', 'type', p.type));
      b.appendChild(el('span', 'where', (p.where ? p.where + ' · ' : '') + p.lat.toFixed(2) + ', ' + p.lon.toFixed(2)));
      b.addEventListener('click', function () {
        hideResults();
        $('#locInput').value = '';
        setPlace(p);
      });
      li.appendChild(b);
      ul.appendChild(li);
    });
    ul.hidden = false;
  }

  function hideResults() { $('#locResults').hidden = true; }

  function findMe() {
    var btn = $('#findMe');
    if (!navigator.geolocation) { setStatus('This browser cannot report a location.', true); return; }
    btn.disabled = true;
    setStatus('Asking the browser for your location…');
    navigator.geolocation.getCurrentPosition(function (pos) {
      btn.disabled = false;
      var lat = +pos.coords.latitude.toFixed(4), lon = +pos.coords.longitude.toFixed(4);
      var place = setPlace({ name: 'Your location', where: '', lat: lat, lon: lon });
      reverseGeocode(lat, lon).then(function (r) {
        if (!r || state.place !== place) return;
        place.name = r.name;
        place.where = r.where;
        save();
        renderPlace();
      });
    }, function (err) {
      btn.disabled = false;
      var why = err.code === 1 ? 'the browser or site policy blocked it' :
                err.code === 2 ? 'no position available' : 'it timed out';
      setStatus('Could not get your location (' + why + '). Search for a place instead.', true);
    }, { timeout: 15000, maximumAge: 600000 });
  }

  /* ---------------- drag-to-reorder (Columns panel) ---------------- */

  function wireDrag(ol) {
    ol.addEventListener('dragstart', function (ev) {
      var li = ev.target.closest('li');
      if (!li) return;
      li.classList.add('dragging');
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/plain', li.dataset.key);
    });
    ol.addEventListener('dragover', function (ev) {
      ev.preventDefault();
      var dragging = ol.querySelector('.dragging');
      if (!dragging) return;
      var after = null, best = -Infinity;
      Array.prototype.forEach.call(ol.children, function (li) {
        if (li === dragging) return;
        var box = li.getBoundingClientRect();
        var offset = ev.clientY - (box.top + box.height / 2);
        if (offset < 0 && offset > best) { best = offset; after = li; }
      });
      if (after === null) ol.appendChild(dragging); else ol.insertBefore(dragging, after);
    });
    ol.addEventListener('drop', function (ev) { ev.preventDefault(); });
    ol.addEventListener('dragend', function () {
      var dragging = ol.querySelector('.dragging');
      if (dragging) dragging.classList.remove('dragging');
      var order = Array.prototype.map.call(ol.children, function (li) { return li.dataset.key; });
      var byKey = {};
      state.cols.forEach(function (c) { byKey[c.key] = c; });
      state.cols = order.map(function (k) { return byKey[k]; }).filter(Boolean);
      applyColumns();
    });
  }

  /* ---------------- init ---------------- */

  function init() {
    load();
    renderSeg('#units', 'units', state.units);
    renderSeg('#step', 'step', state.step);
    renderAvg();
    applyTheme();
    renderColumns();
    renderHead();
    renderSources();

    if (!navigator.geolocation) $('#findMe').hidden = true;

    $('#locForm').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var q = $('#locInput').value.trim();
      if (!q) return;
      hideResults();
      setStatus('Searching for “' + q + '”…');
      geocode(q).then(function (list) {
        loadingStatus();
        if (list.length === 1) { $('#locInput').value = ''; setPlace(list[0]); }
        else showResults(list);
      }).catch(function (e) { setStatus('Search failed: ' + e.message, true); });
    });
    $('#findMe').addEventListener('click', findMe);

    // recent-places tabs: click to switch, × to forget
    $('#tabs').addEventListener('click', function (ev) {
      var x = ev.target.closest('button.x');
      if (x) { forgetPlace(+x.dataset.x); return; }
      var go = ev.target.closest('button.go');
      if (!go) return;
      var p = state.places[+go.dataset.i];
      if (p && p !== state.place) setPlace(p);
    });

    document.addEventListener('click', function (ev) {
      if (!ev.target.closest('.loc')) hideResults();
      if (pop && !pop.hidden && !ev.target.closest('#pop') && !ev.target.closest('td.stat, th[data-c]')) closePop();
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') { hideResults(); closeColumns(); closePop(); }
    });
    window.addEventListener('resize', closePop);

    $('#units').addEventListener('click', function (ev) {
      var b = ev.target.closest('button[data-units]');
      if (!b || b.dataset.units === state.units) return;
      state.units = b.dataset.units;
      save();
      renderSeg('#units', 'units', state.units);
      renderColumns();
      refresh();
    });
    $('#step').addEventListener('click', function (ev) {
      var b = ev.target.closest('button[data-step]');
      if (!b || +b.dataset.step === state.step) return;
      state.step = +b.dataset.step;
      save();
      renderSeg('#step', 'step', state.step);
      closePop();
      renderTable();
    });
    $('#avg').addEventListener('click', function (ev) {
      var b = ev.target.closest('button[data-avg]');
      if (!b || b.dataset.avg === state.avg) return;
      state.avg = b.dataset.avg;
      save();
      renderAvg();
      closePop();
      renderTable();
    });
    $('#mode').addEventListener('click', function (ev) {
      var b = ev.target.closest('button[data-mode]');
      if (!b || b.dataset.mode === state.mode) return;
      state.mode = b.dataset.mode;
      save();
      applyTheme();
    });
    $('#expandAll').addEventListener('click', function () {
      var bodies = document.querySelectorAll('tbody.day');
      var allOpen = bodies.length && Array.prototype.every.call(bodies, function (b) { return b.classList.contains('open'); });
      Array.prototype.forEach.call(bodies, function (b) { state.open[b.dataset.date] = !allOpen; });
      closePop();
      renderTable();
    });

    $('#sourceList').addEventListener('change', function (ev) {
      var cb = ev.target;
      if (!cb.dataset.model) return;
      state.enabled[cb.dataset.model] = cb.checked;
      save();
      $('#srcCount').textContent = enabledCount() + ' of ' + MODELS.length;
      closePop();
      renderTable();
      applyTheme();   // the consensus sky may change with the model set
    });

    // collapsible Sources / Columns panels: one open at a time, both closed on load
    var panels = [
      { btn: $('#srcBtn'), panel: $('#srcPanel') },
      { btn: $('#colsBtn'), panel: $('#colsPanel') }
    ];
    function setPanel(entry, open) {
      entry.panel.hidden = !open;
      entry.btn.setAttribute('aria-expanded', String(open));
    }
    function closeColumns() { panels.forEach(function (p) { setPanel(p, false); }); }
    panels.forEach(function (entry) {
      entry.btn.addEventListener('click', function () {
        var open = entry.panel.hidden;
        panels.forEach(function (p) { setPanel(p, p === entry && open); });
      });
    });
    $('#colsReset').addEventListener('click', function () {
      state.cols = defaultCols();
      applyColumns();
    });
    $('#colList').addEventListener('change', function (ev) {
      var cb = ev.target;
      if (!cb.dataset.col) return;
      var entry = state.cols.find(function (c) { return c.key === cb.dataset.col; });
      if (entry) { entry.on = cb.checked; applyColumns(); }
    });
    $('#colList').addEventListener('click', function (ev) {
      var b = ev.target.closest('button.mv');
      if (!b) return;
      moveCol(b.closest('li').dataset.key, +b.dataset.move);
    });
    wireDrag($('#colList'));

    // table: a stat cell opens its breakdown, a header its explanation, anything else on a day row toggles it
    $('#fcTable').addEventListener('click', function (ev) {
      var td = ev.target.closest('td.stat[data-c]');
      if (td) { popForCell(td); return; }
      var th = ev.target.closest('th[data-c]');
      if (th) { popForHead(th); return; }
      var row = ev.target.closest('tr.d');
      if (!row) return;
      closePop();
      toggleDay(row.parentNode, !row.parentNode.classList.contains('open'));
    });

    if (state.place) { save(); refresh(); }
    else guessPlace().then(function (p) { state.place = rememberPlace(p); save(); refresh(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
