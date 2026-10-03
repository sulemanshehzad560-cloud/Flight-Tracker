import { buildIcons, iconForCategory, iconDataUrl } from './icons.js';
import * as F from './format.js';
import { airlineForCallsign, flightNumberForCallsign, callsignCandidates } from './airlines.js';
import { nativeFetch, isNativeApp, nativeAisStream } from './native-http.js';
import { SHIP_CATEGORIES, shipCategory, shipTypeName, NAV_STATUS, isStopped, shipColor, shipSize } from './ships.js';
import * as Extras from './extras.js';

// Running inside the Android app (no server: the API runs in the page with native HTTP).
const NATIVE = isNativeApp();

// Android app: send JavaScript errors to the app's diagnostics log (capped per session).
if (NATIVE && window.NativeApp) {
  let reported = 0;
  const report = (message) => {
    if (reported++ < 50) window.NativeApp.log('E', String(message).slice(0, 2000));
  };
  window.addEventListener('error', (e) => report(`${e.message} (${e.filename}:${e.lineno}:${e.colno})${e.error?.stack ? `\n${e.error.stack}` : ''}`));
  window.addEventListener('unhandledrejection', (e) => report(`Unhandled rejection: ${e.reason?.stack || e.reason}`));
  document.documentElement.classList.add('native');
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const POLL_REGIONAL_MS = 5000; // zoomed in: detailed feed, near real time
const POLL_GLOBAL_MS = 10000; // zoomed out: world snapshot
const POLL_HIDDEN_MS = 30000; // tab in background
const MAX_EXTRAPOLATE_MS = 10 * 60 * 1000; // dead-reckon positions at most this far ahead
const SIGNAL_LOST_MS = 2 * 60 * 1000;
const HISTORY_POINTS = 400;
const WORLD_ZOOM = 2.6; // below this zoom the whole world is requested
const SHIP_MIN_ZOOM = 0; // ships are shown at every zoom level (the feed follows the visible area)
// In the app the ship feed runs on the phone (cheap to read often); the website asks the server.
const POLL_SHIPS_MS = isNativeApp() ? 4000 : 15000;
const SHIP_EXTRAPOLATE_MS = 30 * 60 * 1000;
const SHIP_TRAIL_POINTS = 300;

const STYLES = {
  builtin: { name: 'Built-in', swatch: 'linear-gradient(135deg,#0a1628,#1b2740 60%,#24324f)', offline: true },
  dark: { name: 'Dark', url: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json', swatch: 'linear-gradient(135deg,#0d1220,#2a3247)' },
  light: { name: 'Light', url: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json', swatch: 'linear-gradient(135deg,#f3f4f6,#cfd5df)', ink: '#1b2333' },
  streets: { name: 'Streets', url: 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json', swatch: 'linear-gradient(135deg,#f6efe3,#a9cbe8)', ink: '#1b2333' },
  satellite: { name: 'Satellite', swatch: 'linear-gradient(135deg,#1f3b2a,#4a5d3a 50%,#1c3550)' },
};

/** Absolute URL of a file next to index.html (MapLibre's workers can't resolve relative URLs). */
const assetUrl = (rel) => new URL(rel, location.href).href;

/** The offline base map bundled with the app (public/map, built by scripts/build-basemap.mjs). */
function builtinStyle() {
  const ink = '#7f8da8';
  const halo = '#0a1628';
  const cityLayer = (id, minzoom, size) => ({
    id, type: 'symbol', source: 'base', 'source-layer': id, minzoom,
    layout: {
      'text-field': ['get', 'name'], 'text-font': ['noto'], 'text-size': size, 'text-anchor': 'top', 'text-offset': [0, 0.4],
      'icon-image': 'city-dot', 'icon-size': 0.5, 'text-optional': true, 'symbol-sort-key': ['-', 0, ['get', 'pop']],
    },
    paint: { 'text-color': '#aab6cc', 'text-halo-color': halo, 'text-halo-width': 1.2 },
  });
  return {
    version: 8,
    glyphs: `${assetUrl('map/glyphs/')}{fontstack}/{range}.pbf`,
    sources: {
      base: {
        type: 'vector', tiles: [`${assetUrl('map/tiles/')}{z}/{x}/{y}.pbf`], minzoom: 0, maxzoom: 9,
        attribution: 'Natural Earth · GeoNames · OurAirports',
      },
    },
    layers: [
      { id: 'ocean', type: 'background', paint: { 'background-color': '#0a1628' } },
      { id: 'land', type: 'fill', source: 'base', 'source-layer': 'land', paint: { 'fill-color': '#18233a' } },
      { id: 'coastline', type: 'line', source: 'base', 'source-layer': 'coastline', paint: { 'line-color': '#2e4266', 'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.5, 8, 1.4] } },
      { id: 'borders', type: 'line', source: 'base', 'source-layer': 'borders', paint: { 'line-color': '#3b4f78', 'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.4, 8, 1.2], 'line-dasharray': [3, 2] } },
      // (Zoom-dependent rules use separate layers with minzoom: filters can't depend on zoom.)
      ...[['large', 1, 3, 5], ['small', 0, 6.5, 7.5]].flatMap(([name, large, dotZoom, labelZoom]) => [
        {
          id: `airport-dots-${name}`, type: 'circle', source: 'base', 'source-layer': 'airports', minzoom: dotZoom,
          filter: ['==', ['get', 'large'], large],
          paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 1.6, 9, 4], 'circle-color': '#8fa3c8', 'circle-stroke-color': halo, 'circle-stroke-width': 1 },
        },
        {
          id: `airport-labels-${name}`, type: 'symbol', source: 'base', 'source-layer': 'airports', minzoom: labelZoom,
          filter: ['==', ['get', 'large'], large],
          layout: { 'text-field': ['get', 'code'], 'text-font': ['noto'], 'text-size': 10, 'text-anchor': 'left', 'text-offset': [0.7, 0], 'text-optional': true },
          paint: { 'text-color': '#8fa3c8', 'text-halo-color': halo, 'text-halo-width': 1 },
        },
      ]),
      cityLayer('cities4', 7, 10), cityLayer('cities3', 5, 10.5), cityLayer('cities2', 3.5, 11.5), cityLayer('cities1', 2, 12.5),
      ...[['big', ['>', ['get', 'area'], 30], 1.5], ['small', ['<=', ['get', 'area'], 30], 3.5]].map(([name, filter, minzoom]) => ({
        id: `country-labels-${name}`, type: 'symbol', source: 'base', 'source-layer': 'countries', minzoom, maxzoom: 7, filter,
        layout: { 'text-field': ['upcase', ['get', 'name']], 'text-font': ['noto'], 'text-size': ['interpolate', ['linear'], ['zoom'], 2, 9, 6, 13], 'text-letter-spacing': 0.12, 'text-max-width': 7 },
        paint: { 'text-color': ink, 'text-halo-color': halo, 'text-halo-width': 1.2 },
      })),
    ],
  };
}

function styleFor(id) {
  if (id === 'builtin') return builtinStyle();
  return STYLES[id]?.url || satelliteStyle();
}

function satelliteStyle() {
  const esri = 'https://server.arcgisonline.com/ArcGIS/rest/services';
  return {
    version: 8,
    glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
    sources: {
      imagery: { type: 'raster', tiles: [`${esri}/World_Imagery/MapServer/tile/{z}/{y}/{x}`], tileSize: 256, maxzoom: 19, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' },
      places: { type: 'raster', tiles: [`${esri}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`], tileSize: 256, maxzoom: 19 },
    },
    layers: [
      { id: 'imagery', type: 'raster', source: 'imagery' },
      { id: 'places', type: 'raster', source: 'places', paint: { 'raster-opacity': 0.85 } },
    ],
  };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const DEFAULT_FILTERS = { altMin: 0, altMax: 50000, airliners: true, light: true, heli: true, ground: true, military: false, prefix: '' };

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`ft:${key}`);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`ft:${key}`, JSON.stringify(value));
    } catch {
      // storage unavailable (private mode etc.) – settings just won't persist
    }
  },
};

const state = {
  aircraft: new Map(), // hex -> normalized aircraft (+ derived fields prefixed with _)
  history: new Map(), // hex -> [[lon, lat, altFt, ts], ...]
  selected: null,
  selectedMissingSince: 0,
  track: [], // server-provided flight path of the selected aircraft
  route: null,
  routeFor: null,
  details: null,
  follow: false,
  filters: { ...DEFAULT_FILTERS, ...store.get('filters', {}) },
  // The Android app opens on the bundled offline map; the website on the detailed online map.
  settings: {
    style: NATIVE ? 'builtin' : 'dark', globe: false, labels: true, trails: false, units: 'aviation', ships: true,
    // Weather starts on (rain radar) so it's visible on first launch; the user can switch it off.
    airports: true, daynight: false, weatherMode: 'radar', weatherOpacity: 0.65, ...store.get('settings', {}),
  },
  lastOk: 0,
  lastError: null,
  mode: '',
  sources: [],
  notices: [],
  clockOffset: 0,
  visibleCount: 0,
  // Ships (AIS)
  ships: new Map(), // MMSI -> normalized ship
  shipTrails: new Map(), // MMSI -> [[lon, lat, ts], ...]
  selectedShip: null,
  shipSources: [],
  shipNotices: [],
  shipVisibleCount: 0,
  shipsPolled: false,
  // Airports (bundled list, for search and the airport panel)
  airports: [],
  selectedAirport: null,
  builtinAvailable: true,
};
F.setUnits(state.settings.units);

const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

if (!window.maplibregl) {
  document.body.insertAdjacentHTML('beforeend', '<div class="toast error">The map library could not be loaded. Check your internet connection and reload.</div>');
  throw new Error('maplibre-gl not loaded');
}

const savedView = store.get('view', null);
const map = new maplibregl.Map({
  container: 'map',
  style: styleFor(state.settings.style),
  center: savedView?.center || [20, 28],
  zoom: savedView?.zoom ?? 2.2,
  minZoom: 1,
  maxPitch: 70,
  attributionControl: { compact: true },
  fadeDuration: 0,
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'nautical' }), 'bottom-right');

let labelFont = ['Open Sans Regular'];

function pickFont() {
  for (const layer of map.getStyle().layers || []) {
    const font = layer.layout?.['text-font'];
    if (layer.type === 'symbol' && Array.isArray(font) && font.every((f) => typeof f === 'string')) return font;
  }
  return ['Open Sans Regular'];
}

const EMPTY = { type: 'FeatureCollection', features: [] };

function setupLayers() {
  labelFont = pickFont();
  map.setProjection({ type: state.settings.globe ? 'globe' : 'mercator' });

  styleLoaded = true;
  for (const [name, image] of Object.entries(buildIcons())) {
    if (!map.hasImage(`ac-${name}`)) map.addImage(`ac-${name}`, image, { sdf: true, pixelRatio: 2 });
  }
  if (!map.hasImage('city-dot')) map.addImage('city-dot', Extras.dotImage('#c8d3e6', '#0a1628'), { pixelRatio: 2 });

  Extras.addOverlays(map, state.settings);
  const sources = ['aircraft', 'ships', 'trail', 'trails-all', 'route', 'airports'];
  for (const id of sources) if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: EMPTY });

  // Zoom must be the top-level input of the expression, so scale each stop by the per-aircraft size.
  const iconSize = (scale = 1) => ['interpolate', ['linear'], ['zoom'],
    ...[[1, 0.42], [4, 0.55], [8, 0.82], [12, 1.05]].flatMap(([z, s]) => [z, ['*', s * scale, ['get', 'sz']]])];

  map.addLayer({
    id: 'trails-all', type: 'line', source: 'trails-all',
    layout: { 'line-cap': 'round', 'line-join': 'round', visibility: state.settings.trails ? 'visible' : 'none' },
    paint: { 'line-color': ['get', 'color'], 'line-width': 1.4, 'line-opacity': 0.55 },
  });
  map.addLayer({
    id: 'route-line', type: 'line', source: 'route',
    layout: { 'line-cap': 'round' },
    paint: {
      'line-color': '#ffffff',
      'line-width': 1.6,
      'line-opacity': ['case', ['==', ['get', 'part'], 'remaining'], 0.55, 0.22],
      'line-dasharray': [2, 2.5],
    },
  });
  map.addLayer({
    id: 'trail', type: 'line', source: 'trail',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 2, 2, 10, 3.5] },
  });
  map.addLayer({
    id: 'airports-dot', type: 'circle', source: 'airports',
    paint: { 'circle-radius': 5, 'circle-color': '#ffffff', 'circle-stroke-color': '#0b1020', 'circle-stroke-width': 2 },
  });
  map.addLayer({
    id: 'airports-label', type: 'symbol', source: 'airports',
    layout: { 'text-field': ['get', 'label'], 'text-font': labelFont, 'text-size': 12, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-allow-overlap': true },
    paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(0,0,0,0.85)', 'text-halo-width': 1.5 },
  });
  map.addLayer({
    id: 'ship-icons', type: 'symbol', source: 'ships',
    layout: {
      'icon-image': ['concat', 'ac-', ['get', 'icon']],
      'icon-size': iconSize(1.3),
      'icon-rotate': ['get', 'k'],
      'icon-rotation-alignment': 'map',
      'icon-pitch-alignment': 'map',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
      visibility: state.settings.ships ? 'visible' : 'none',
    },
    paint: {
      'icon-color': ['get', 'col'],
      'icon-opacity': ['case', ['==', ['get', 'st'], 1], 0.72, 1], // moored / at anchor: a little fainter
      'icon-halo-color': 'rgba(5,8,18,0.85)',
      'icon-halo-width': 1.2,
    },
  });
  map.addLayer({
    id: 'ship-labels', type: 'symbol', source: 'ships', minzoom: 9,
    layout: {
      'text-field': ['get', 'n'], 'text-font': labelFont, 'text-size': 10, 'text-offset': [0, 1.3], 'text-anchor': 'top',
      'text-optional': true, visibility: state.settings.ships && state.settings.labels ? 'visible' : 'none',
    },
    paint: { 'text-color': '#cfe6ff', 'text-halo-color': 'rgba(5,8,18,0.85)', 'text-halo-width': 1.2 },
  });
  map.addLayer({
    id: 'aircraft-icons', type: 'symbol', source: 'aircraft',
    layout: {
      'icon-image': ['concat', 'ac-', ['get', 'icon']],
      'icon-size': iconSize(),
      'icon-rotate': ['get', 'k'],
      'icon-rotation-alignment': 'map',
      'icon-pitch-alignment': 'map',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
      'symbol-sort-key': ['get', 'alt'],
    },
    paint: {
      'icon-color': F.altitudeColorExpression(),
      'icon-halo-color': 'rgba(5,8,18,0.75)',
      'icon-halo-width': 1.2,
    },
  });
  map.addLayer({
    id: 'aircraft-labels', type: 'symbol', source: 'aircraft', minzoom: 6.5,
    layout: {
      'text-field': ['get', 'c'], 'text-font': labelFont, 'text-size': 11, 'text-offset': [0, 1.4], 'text-anchor': 'top',
      'text-optional': true, visibility: state.settings.labels ? 'visible' : 'none',
    },
    paint: { 'text-color': '#f4f6fb', 'text-halo-color': 'rgba(5,8,18,0.85)', 'text-halo-width': 1.3 },
  });
  applySelectionFilter();
  render(true);
  renderSelectionOverlays();
  renderAllTrails();
}

map.on('style.load', setupLayers);

// Handy for debugging from the browser console.
window.flightTracker = {
  map,
  state,
  /** Android back button: close the top-most thing; false when there was nothing to close. */
  back() {
    if (!resultsEl.hidden) hideResults();
    else if (document.querySelector('.popover:not([hidden])')) closePopovers();
    else if (state.selected || state.selectedShip || state.selectedAirport) deselect();
    else return false;
    return true;
  },
};

function applySelectionFilter() {
  if (!map.getLayer('aircraft-icons')) return;
  const filter = state.selected ? ['!=', ['get', 'h'], state.selected] : null;
  map.setFilter('aircraft-icons', filter);
  map.setFilter('aircraft-labels', filter);
  const shipFilter = state.selectedShip ? ['!=', ['get', 'id'], state.selectedShip] : null;
  map.setFilter('ship-icons', shipFilter);
  map.setFilter('ship-labels', shipFilter);
}

// ---------------------------------------------------------------------------
// Map styles (with automatic fallback to the built-in map when offline)
// ---------------------------------------------------------------------------

let styleLoaded = false;
let styleTimer = null;

function watchStyleLoad(id) {
  clearTimeout(styleTimer);
  if (id === 'builtin' || !state.builtinAvailable) return;
  // An online map that hasn't loaded after a while (no connection): show the bundled map instead.
  styleTimer = setTimeout(() => {
    if (!styleLoaded) {
      toast('The online map could not be loaded – showing the built-in offline map.');
      setMapStyle('builtin', { remember: false });
    }
  }, 9000);
}

function setMapStyle(id, { remember = true } = {}) {
  if (remember) {
    state.settings.style = id;
    saveSettings();
  }
  styleLoaded = false;
  document.querySelectorAll('.style-btn').forEach((b) => b.classList.toggle('active', b.dataset.style === id));
  map.setStyle(styleFor(id), { diff: false });
  watchStyleLoad(id);
}
watchStyleLoad(state.settings.style);

// ---------------------------------------------------------------------------
// Data: fetching & merging
// ---------------------------------------------------------------------------

let localApi = null;

/** Android app: the same API as server.js, running in the page (lib/api.js) over native HTTP. */
function getLocalApi() {
  localApi ??= (async () => {
    const [{ createApi }, providers, { ShipTracker }] = await Promise.all([
      import('../../lib/api.js'), import('../../lib/providers.js'), import('../../lib/ships.js'),
    ]);
    providers.setFetch(nativeFetch);
    // Worldwide ships come from aisstream.io through the app's native WebSocket (when a key was built in);
    // the phone subscribes only to the area on screen.
    const ships = new ShipTracker({ openStream: window.NativeAis?.isAvailable() ? nativeAisStream : null, globalStream: false });
    return createApi({ opensky: new providers.OpenSkyGlobal({}), ships, statusExtra: () => ({ app: 'android' }) });
  })();
  return localApi;
}

async function api(path, { signal } = {}) {
  if (NATIVE) {
    const handle = await getLocalApi();
    const [status, data] = await handle(new URL(path, location.href));
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (status >= 400) throw new Error(data.error || `Error ${status}`);
    // Copy: the UI annotates aircraft objects, which must not leak back into the API's caches.
    return structuredClone(data);
  }
  const res = await fetch(path, { signal });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
  return data;
}

function enrich(ac) {
  const [icon, size] = iconForCategory(ac.ct, ac.t);
  ac._icon = icon;
  ac._size = size;
  ac._kind = icon === 'heli' ? 'heli' : ['light', 'glider', 'balloon'].includes(icon) ? 'light' : icon === 'ground' ? 'vehicle' : 'airliner';
  ac._airline = airlineForCallsign(ac.c);
  ac._fn = flightNumberForCallsign(ac.c);
  ac._em = Boolean(F.EMERGENCY_SQUAWKS[ac.q]);
  if (!ac._clock) {
    ac.ts += state.clockOffset; // server time -> this browser's clock
    ac._clock = true;
  }
  return ac;
}

function rememberPosition(ac) {
  let hist = state.history.get(ac.h);
  if (!hist) {
    hist = [];
    state.history.set(ac.h, hist);
  }
  const last = hist[hist.length - 1];
  if (last && (last[3] >= ac.ts || (last[0] === ac.lo && last[1] === ac.la))) return;
  hist.push([ac.lo, ac.la, ac.g ? -1 : ac.a, ac.ts]);
  if (hist.length > HISTORY_POINTS) hist.splice(0, hist.length - HISTORY_POINTS);
}

/** Replace the aircraft set with a fresh response (keeping the selected aircraft). */
function ingest(list) {
  const next = new Map();
  for (const raw of list) {
    const ac = enrich(raw);
    const prev = state.aircraft.get(ac.h);
    // Keep the newer of two positions (a stale world snapshot must not move a plane backwards).
    if (prev && prev.ts > ac.ts) {
      next.set(ac.h, prev);
      continue;
    }
    rememberPosition(ac);
    next.set(ac.h, ac);
  }
  if (state.selected && !next.has(state.selected) && state.aircraft.has(state.selected)) {
    next.set(state.selected, state.aircraft.get(state.selected));
  }
  state.aircraft = next;

  // Forget trails of aircraft that left long ago.
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [hex, hist] of state.history) {
    if (!next.has(hex) && hist[hist.length - 1][3] < cutoff) state.history.delete(hex);
  }
}

/** Add or update individual aircraft without dropping the others (search results, selected refresh). */
function upsert(list) {
  for (const raw of list) {
    const ac = enrich(raw);
    const prev = state.aircraft.get(ac.h);
    if (prev && prev.ts > ac.ts) continue;
    rememberPosition(ac);
    state.aircraft.set(ac.h, prev ? { ...prev, ...Object.fromEntries(Object.entries(ac).filter(([, v]) => v !== '' && v !== null)) } : ac);
  }
}

function viewBox() {
  if (map.getZoom() < WORLD_ZOOM) return { lamin: -90, lomin: -180, lamax: 90, lomax: 180 };
  const b = map.getBounds();
  const padLat = (b.getNorth() - b.getSouth()) * 0.1;
  const padLon = (b.getEast() - b.getWest()) * 0.1;
  const box = {
    lamin: Math.max(-90, b.getSouth() - padLat),
    lamax: Math.min(90, b.getNorth() + padLat),
    lomin: b.getWest() - padLon,
    lomax: b.getEast() + padLon,
  };
  if (box.lomax - box.lomin >= 360) Object.assign(box, { lomin: -180, lomax: 180 });
  return box;
}

let pollTimer = null;
let pollController = null;

async function poll() {
  clearTimeout(pollTimer);
  pollController?.abort();
  const controller = new AbortController();
  pollController = controller;
  const box = viewBox();
  const qs = new URLSearchParams(Object.entries(box).map(([k, v]) => [k, v.toFixed(3)]));
  try {
    const data = await api(`/api/aircraft?${qs}`, { signal: controller.signal });
    state.clockOffset = Date.now() - data.now;
    state.mode = data.mode;
    state.sources = data.sources || [];
    state.notices = data.notices || [];
    state.lastOk = Date.now();
    state.lastError = null;
    ingest(data.aircraft || []);
    await refreshSelectedIfMissing(controller.signal);
    render(true);
    renderAllTrails();
    if (state.selected) {
      renderSelectionOverlays();
      maybeReloadRoute();
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    state.lastError = err.message;
  } finally {
    if (pollController === controller) {
      pollController = null;
      const delay = document.hidden ? POLL_HIDDEN_MS : state.mode === 'regional' ? POLL_REGIONAL_MS : POLL_GLOBAL_MS;
      pollTimer = setTimeout(poll, state.lastError ? Math.min(delay, 8000) : delay);
      updateStatus();
      Splash.step('flights', state.lastError ? 'warn' : 'ok', state.lastError ? 'No connection yet – retrying' : `${F.fmtNumber(state.aircraft.size)} aircraft`);
    }
  }
}

async function refreshSelectedIfMissing(signal) {
  const hex = state.selected;
  if (!hex) return;
  const ac = state.aircraft.get(hex);
  if (ac && Date.now() - ac.ts < 30000) {
    state.selectedMissingSince = 0;
    return;
  }
  try {
    const data = await api(`/api/aircraft/${hex}`, { signal });
    if (data.aircraft) {
      upsert([data.aircraft]);
      state.selectedMissingSince = 0;
    } else if (!state.selectedMissingSince) {
      state.selectedMissingSince = Date.now();
    }
  } catch (err) {
    if (err.name === 'AbortError') throw err;
  }
}

let moveTimer = null;
map.on('moveend', () => {
  clearTimeout(moveTimer);
  moveTimer = setTimeout(() => {
    poll();
    pollShips();
  }, 350);
  const c = map.getCenter();
  store.set('view', { center: [+c.lng.toFixed(3), +c.lat.toFixed(3)], zoom: +map.getZoom().toFixed(2) });
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    poll();
    pollShips();
  }
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function currentPosition(ac, now = Date.now()) {
  const age = now - ac.ts;
  if (ac.g || !ac.s || ac.s < 30 || ac.k === null || age <= 0) return [ac.la, ac.lo];
  return F.project(ac.la, ac.lo, ac.k, (ac.s * Math.min(age, MAX_EXTRAPOLATE_MS)) / 3600000);
}

function passesFilters(ac) {
  const f = state.filters;
  if (ac.h === state.selected) return true;
  if (ac.g && !f.ground) return false;
  if (ac._kind === 'vehicle' && !f.ground) return false;
  if (ac._kind === 'airliner' && !f.airliners) return false;
  if (ac._kind === 'light' && !f.light) return false;
  if (ac._kind === 'heli' && !f.heli) return false;
  if (f.military && !ac.m) return false;
  if (!ac.g && (f.altMin > 0 || f.altMax < 50000)) {
    const alt = ac.a ?? 0;
    if (alt < f.altMin || (f.altMax < 50000 && alt > f.altMax)) return false;
  }
  if (f.prefix) {
    const p = f.prefix;
    if (!ac.c.toUpperCase().startsWith(p) && !(ac._fn && ac._fn.startsWith(p))) return false;
  }
  return true;
}

function featureFor(ac, now) {
  const [la, lo] = currentPosition(ac, now);
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lo, la] },
    properties: {
      h: ac.h,
      c: ac.c || ac.r || ac.h.toUpperCase(),
      icon: ac._icon,
      sz: ac._size,
      k: ac.k ?? 0,
      alt: ac.g ? -1 : ac.a ?? 0,
      em: ac._em ? 1 : 0,
    },
  };
}

let lastFullRender = 0;

/** Redraw aircraft positions (dead-reckoned). `force` bypasses the frame throttle. */
function render(force = false) {
  const now = Date.now();
  // Fewer aircraft -> smoother animation; the whole world updates about once a second.
  const interval = Math.min(1200, Math.max(250, (state.aircraft.size + state.ships.size) / 8));
  if (!force && now - lastFullRender < interval) return;
  lastFullRender = now;
  const source = map.getSource('aircraft');
  if (!source) return;

  const features = [];
  for (const ac of state.aircraft.values()) {
    if (passesFilters(ac)) features.push(featureFor(ac, now));
  }
  state.visibleCount = features.length;
  source.setData({ type: 'FeatureCollection', features });

  const shipSource = map.getSource('ships');
  if (shipSource) {
    const shipFeatures = [];
    if (state.settings.ships) for (const ship of state.ships.values()) shipFeatures.push(shipFeature(ship, now));
    state.shipVisibleCount = shipFeatures.length;
    shipSource.setData({ type: 'FeatureCollection', features: shipFeatures });
  }
}

// The selected aircraft is an HTML marker, animated every frame for perfectly smooth movement.
const selectedEl = document.createElement('div');
selectedEl.className = 'sel-marker';
selectedEl.innerHTML = '<div class="sel-ring"></div><img class="sel-plane" alt=""><div class="sel-label"></div>';
const selectedMarker = new maplibregl.Marker({ element: selectedEl }); // plane rotation handled below
let selectedMarkerHex = null;

/** What the highlighted marker shows: the selected aircraft or ship (null when nothing is selected). */
function selectedTarget() {
  const ac = state.selected && state.aircraft.get(state.selected);
  if (ac) {
    const [la, lo] = currentPosition(ac);
    return { key: `ac:${ac.h}`, icon: ac._icon, size: ac._size, label: ac.c || ac.r || ac.h.toUpperCase(), la, lo, rot: ac.k ?? 0 };
  }
  const ship = state.selectedShip && state.ships.get(state.selectedShip);
  if (ship) {
    const [la, lo] = shipPosition(ship);
    const stopped = isStopped(ship);
    return { key: `ship:${ship.id}:${stopped}`, icon: 'ship', size: shipSize(ship), label: ship.n || ship.id, la, lo, rot: ship.h ?? ship.c ?? 0 };
  }
  return null;
}

function renderSelectedMarker() {
  const t = selectedTarget();
  if (!t) {
    if (selectedMarkerHex) selectedMarker.remove();
    selectedMarkerHex = null;
    return;
  }
  if (selectedMarkerHex !== t.key) {
    selectedEl.querySelector('.sel-plane').src = iconDataUrl(t.icon, '#ffc21a');
    selectedEl.style.setProperty('--sz', t.size);
    selectedMarker.setLngLat([t.lo, t.la]).addTo(map);
    selectedMarkerHex = t.key;
  }
  selectedEl.querySelector('.sel-label').textContent = t.label;
  selectedMarker.setLngLat([t.lo, t.la]);
  selectedEl.querySelector('.sel-plane').style.transform = `rotate(${t.rot - map.getBearing()}deg)`;
  if (state.follow && !map.isMoving() && !userInteracting) map.jumpTo({ center: [t.lo, t.la] });
}

let userInteracting = false;
map.on('dragstart', () => {
  userInteracting = true;
  if (state.follow) setFollow(false);
});
map.on('dragend', () => { userInteracting = false; });

function frame() {
  requestAnimationFrame(frame);
  if (document.hidden) return;
  render();
  renderSelectedMarker();
}
requestAnimationFrame(frame);

setInterval(() => {
  updateStatus();
  updateLiveDetails();
}, 1000);

/** Trail segments coloured by altitude; breaks the line on long gaps. */
function trailFeatures(points) {
  const features = [];
  for (let i = 1; i < points.length; i++) {
    const [lo1, la1, a1, t1] = points[i - 1];
    let [lo2, la2, a2, t2] = points[i];
    if (t2 - t1 > 20 * 60 * 1000 || F.distanceNm(la1, lo1, la2, lo2) > 300) continue;
    if (lo2 - lo1 > 180) lo2 -= 360;
    else if (lo2 - lo1 < -180) lo2 += 360;
    const alt = a2 === null ? a1 : a2;
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [[lo1, la1], [lo2, la2]] },
      properties: { color: F.altitudeColor(alt, alt === -1) },
    });
  }
  return features;
}

function selectedTrailPoints() {
  const hex = state.selected;
  const ac = hex && state.aircraft.get(hex);
  if (!ac) return [];
  const hist = state.history.get(hex) || [];
  const firstLocal = hist.length ? hist[0][3] : Infinity;
  const fromServer = state.track.filter((p) => p.ts < firstLocal).map((p) => [p.lo, p.la, p.a === 0 ? -1 : p.a, p.ts]);
  const points = [...fromServer, ...hist];
  const [la, lo] = currentPosition(ac);
  points.push([lo, la, ac.g ? -1 : ac.a, Date.now()]);
  return points;
}

function renderSelectionOverlays() {
  const trail = map.getSource('trail');
  const route = map.getSource('route');
  const airports = map.getSource('airports');
  if (!trail || !route || !airports) return;
  const ship = state.selectedShip && state.ships.get(state.selectedShip);
  if (ship) {
    trail.setData({ type: 'FeatureCollection', features: shipTrailFeatures(ship) });
    route.setData(EMPTY);
    airports.setData(EMPTY);
    return;
  }
  const ac = state.selected && state.aircraft.get(state.selected);
  if (!ac) {
    trail.setData(EMPTY);
    route.setData(EMPTY);
    airports.setData(EMPTY);
    return;
  }
  trail.setData({ type: 'FeatureCollection', features: trailFeatures(selectedTrailPoints()) });

  const r = state.route;
  if (!r) {
    route.setData(EMPTY);
    airports.setData(EMPTY);
    return;
  }
  const [la, lo] = currentPosition(ac);
  const lines = [];
  if (r.origin) lines.push({ type: 'Feature', properties: { part: 'flown' }, geometry: { type: 'LineString', coordinates: F.greatCircle(r.origin.lat, r.origin.lon, la, lo) } });
  if (r.destination) {
    const coords = F.greatCircle(la, lo, r.destination.lat, r.destination.lon);
    lines.push({ type: 'Feature', properties: { part: 'remaining' }, geometry: { type: 'LineString', coordinates: coords } });
  }
  route.setData({ type: 'FeatureCollection', features: lines });
  airports.setData({
    type: 'FeatureCollection',
    features: [r.origin, ...(r.stops || []), r.destination].filter(Boolean).map((a) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [a.lon, a.lat] },
      properties: { label: a.iata || a.icao },
    })),
  });
}

function renderAllTrails() {
  const source = map.getSource('trails-all');
  if (!source) return;
  if (!state.settings.trails) {
    source.setData(EMPTY);
    return;
  }
  const features = [];
  for (const ac of state.aircraft.values()) {
    if (ac.h === state.selected || !passesFilters(ac)) continue;
    const hist = state.history.get(ac.h);
    if (!hist || hist.length < 2) continue;
    const coords = [];
    let prev = null;
    for (const [lo, la] of hist) {
      let lon = lo;
      if (prev !== null) {
        if (lon - prev > 180) lon -= 360;
        else if (lon - prev < -180) lon += 360;
      }
      coords.push([lon, la]);
      prev = lon;
    }
    features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: { color: F.altitudeColor(ac.a, ac.g) } });
  }
  source.setData({ type: 'FeatureCollection', features });
}

// ---------------------------------------------------------------------------
// Selection, route, aircraft details
// ---------------------------------------------------------------------------

let selectToken = 0;

async function selectAircraft(hex, { fly = false, follow = false } = {}) {
  if (!hex) return deselect();
  const token = ++selectToken;
  state.selectedShip = null;
  state.selectedAirport = null;
  state.selected = hex;
  state.selectedMissingSince = 0;
  state.track = [];
  state.route = null;
  state.routeFor = null;
  state.details = null;
  setFollow(follow);
  applySelectionFilter();
  renderDetails();
  render(true);
  renderSelectionOverlays();
  updateUrl();

  const ac = state.aircraft.get(hex);
  if (fly && ac) {
    const [la, lo] = currentPosition(ac);
    map.flyTo({ center: [lo, la], zoom: Math.max(map.getZoom(), 7.5), speed: 1.4, essential: true });
  }

  maybeReloadRoute();
  api(`/api/details?hex=${hex}`).then((d) => {
    if (token !== selectToken) return;
    state.details = d.details;
    renderDetails();
  }).catch(() => {});
  api(`/api/track?hex=${hex}`).then((d) => {
    if (token !== selectToken) return;
    state.track = d.path || [];
    renderSelectionOverlays();
    renderProfile();
  }).catch(() => {});
}

function maybeReloadRoute() {
  const ac = state.selected && state.aircraft.get(state.selected);
  if (!ac || !ac.c || state.routeFor === ac.c) return;
  const token = selectToken;
  state.routeFor = ac.c;
  const qs = new URLSearchParams({ callsign: ac.c, lat: ac.la, lon: ac.lo });
  api(`/api/route?${qs}`).then((d) => {
    if (token !== selectToken) return;
    state.route = d.route;
    renderDetails();
    renderSelectionOverlays();
  }).catch(() => {});
}

function deselect() {
  selectToken++;
  state.selected = null;
  state.selectedShip = null;
  state.selectedAirport = null;
  state.route = null;
  state.track = [];
  setFollow(false);
  applySelectionFilter();
  $('#details').hidden = true;
  updateMapPadding();
  render(true);
  renderSelectionOverlays();
  updateUrl();
}

function setFollow(on) {
  state.follow = on;
  $('#btn-follow')?.classList.toggle('active', on);
  if (on) {
    const t = selectedTarget();
    if (t) map.easeTo({ center: [t.lo, t.la], duration: 600 });
  }
}

function updateUrl() {
  const ac = state.selected && state.aircraft.get(state.selected);
  const url = new URL(location.href);
  url.searchParams.delete('flight');
  url.searchParams.delete('hex');
  url.searchParams.delete('ship');
  if (state.selectedShip) url.searchParams.set('ship', state.selectedShip);
  if (ac) {
    if (ac.c) url.searchParams.set('flight', ac.c);
    else url.searchParams.set('hex', ac.h);
  }
  history.replaceState(null, '', url);
}

/** Origin/destination progress, sanity-checked against the aircraft's actual position. */
function routeProgress(ac, r) {
  if (!r?.origin || !r?.destination) return null;
  const [la, lo] = currentPosition(ac);
  const total = F.distanceNm(r.origin.lat, r.origin.lon, r.destination.lat, r.destination.lon);
  const flown = F.distanceNm(r.origin.lat, r.origin.lon, la, lo);
  const remaining = F.distanceNm(la, lo, r.destination.lat, r.destination.lon);
  const plausible = flown + remaining <= total * 1.3 + 150;
  const fraction = Math.min(1, Math.max(0, flown / Math.max(1, flown + remaining)));
  const etaHours = ac.s > 50 ? remaining / ac.s : null;
  return { total, flown, remaining, fraction, plausible, etaHours };
}

const ICON_SVG = {
  close: '<svg viewBox="0 0 24 24"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7l1.4-1.4 6.3 6.3 6.3-6.3z" transform="translate(1.4 0)"/></svg>',
  follow: '<svg viewBox="0 0 24 24"><path d="M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8zm-1-7h2v3.06A8 8 0 0 1 19.94 11H23v2h-3.06A8 8 0 0 1 13 19.94V23h-2v-3.06A8 8 0 0 1 4.06 13H1v-2h3.06A8 8 0 0 1 11 4.06z"/></svg>',
  share: '<svg viewBox="0 0 24 24"><path d="M18 16a3 3 0 0 0-2.4 1.2l-6.7-3.4a3 3 0 0 0 0-1.6l6.7-3.4A3 3 0 1 0 15 7c0 .3 0 .5.1.8L8.4 11.2a3 3 0 1 0 0 3.6l6.7 3.4A3 3 0 1 0 18 16z"/></svg>',
  plane: '<svg viewBox="0 0 24 24"><path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z"/></svg>',
  arrow: '<svg viewBox="0 0 24 24"><path d="M4 11h12.2l-5.6-5.6L12 4l8 8-8 8-1.4-1.4 5.6-5.6H4z"/></svg>',
};

/** Keep the followed aircraft centred in the part of the map not covered by the details panel. */
function updateMapPadding() {
  const panel = $('#details');
  const open = !panel.hidden;
  const mobile = matchMedia('(max-width: 720px)').matches;
  map.setPadding({
    left: open && !mobile ? panel.offsetWidth + 12 : 0,
    bottom: open && mobile ? panel.offsetHeight : 0,
    top: 0,
    right: 0,
  });
}

function renderDetails() {
  if (state.selectedShip) return renderShipDetails();
  if (state.selectedAirport) return renderAirportDetails();
  const panel = $('#details');
  const ac = state.selected && state.aircraft.get(state.selected);
  if (!ac) {
    panel.hidden = true;
    updateMapPadding();
    return;
  }
  const r = state.route;
  const d = state.details;
  const airlineName = r?.airline?.name || ac._airline?.name || ac.o || d?.owner || '';
  const flightNo = ac._fn || r?.flightNumber || '';
  const title = ac.c || ac.r || d?.registration || ac.h.toUpperCase();
  const typeName = d?.type || ac.d || '';
  const badges = [];
  if (ac._em) badges.push(`<span class="badge danger">Squawk ${ac.q} · ${F.EMERGENCY_SQUAWKS[ac.q]}</span>`);
  if (ac.m) badges.push('<span class="badge mil">Military</span>');
  if (ac.ct && F.CATEGORY_LABELS[ac.ct]) badges.push(`<span class="badge">${F.CATEGORY_LABELS[ac.ct]}</span>`);
  if (ac.g) badges.push('<span class="badge">On ground</span>');

  const photo = d?.photo?.url
    ? `<div class="d-photo"><img src="${F.escapeHtml(d.photo.url)}" alt="Photo of ${F.escapeHtml(title)}" loading="lazy" referrerpolicy="no-referrer">
         <a class="credit" href="${F.escapeHtml(d.photo.link || d.photo.url)}" target="_blank" rel="noopener">© ${F.escapeHtml(d.photo.credit || d.photo.source)}</a></div>`
    : '';

  let routeHtml;
  if (r?.origin && r?.destination) {
    routeHtml = `
      <div class="route-ends">
        <div class="route-end"><div class="code">${F.escapeHtml(r.origin.iata || r.origin.icao)}</div><div class="city" title="${F.escapeHtml(r.origin.name)}">${F.escapeHtml(r.origin.city || r.origin.name)}</div></div>
        <div class="route-mid">${ICON_SVG.arrow}</div>
        <div class="route-end dest"><div class="code">${F.escapeHtml(r.destination.iata || r.destination.icao)}</div><div class="city" title="${F.escapeHtml(r.destination.name)}">${F.escapeHtml(r.destination.city || r.destination.name)}</div></div>
      </div>
      <div class="route-bar"><div class="fill" id="rp-fill"></div><svg class="plane" id="rp-plane" viewBox="0 0 24 24"><path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z"/></svg></div>
      <div class="route-meta"><span id="rp-flown"></span><span id="rp-left"></span></div>
      <div class="route-eta" id="rp-eta"></div>
      <div class="route-note" id="rp-note"></div>`;
  } else {
    routeHtml = `<div class="route-unknown">${state.routeFor && !r ? 'Route not available for this flight.' : ac.c ? 'Looking up route…' : 'No callsign broadcast — route unknown.'}</div>`;
  }

  panel.innerHTML = `
    <div class="d-head">
      <div class="d-head-top">
        <div>
          <div class="d-callsign">${F.escapeHtml(title)}${flightNo && flightNo !== title ? `<span class="d-flightno">${F.escapeHtml(flightNo)}</span>` : ''}</div>
          <div class="d-airline">${F.escapeHtml(airlineName || typeName || 'Unknown operator')}</div>
        </div>
        <div class="d-actions">
          <button class="icon-btn ${state.follow ? 'active' : ''}" id="btn-follow" title="Follow (F)" aria-label="Follow this aircraft">${ICON_SVG.follow}</button>
          ${NATIVE ? '' : `<button class="icon-btn" id="btn-share" title="Copy link" aria-label="Copy link to this flight">${ICON_SVG.share}</button>`}
          <button class="icon-btn" id="btn-close" title="Close (Esc)" aria-label="Close">${ICON_SVG.close}</button>
        </div>
      </div>
      ${badges.length ? `<div class="badges">${badges.join('')}</div>` : ''}
    </div>
    <div class="d-scroll">
      ${photo}
      <div class="d-route">${routeHtml}</div>
      <div class="d-section">
        <h4>Live data</h4>
        <div class="stat-grid" id="d-live"></div>
      </div>
      <div class="d-section">
        <h4>Altitude profile</h4>
        <div class="profile" id="d-profile"><div class="profile-empty">Collecting data…</div></div>
      </div>
      <div class="d-section">
        <h4>Aircraft</h4>
        <dl class="kv">
          <dt>Type</dt><dd>${F.escapeHtml(typeName || '—')}${ac.t || d?.icaoType ? ` <span class="mono">(${F.escapeHtml(ac.t || d.icaoType)})</span>` : ''}</dd>
          <dt>Registration</dt><dd class="mono">${F.escapeHtml(ac.r || d?.registration || '—')}</dd>
          <dt>ICAO 24-bit</dt><dd class="mono">${ac.h.toUpperCase()}</dd>
          ${d?.manufacturer ? `<dt>Manufacturer</dt><dd>${F.escapeHtml(d.manufacturer)}</dd>` : ''}
          <dt>Operator</dt><dd>${F.escapeHtml(ac.o || d?.owner || airlineName || '—')}</dd>
          <dt>Country</dt><dd>${F.escapeHtml(ac.co || d?.ownerCountry || '—')}</dd>
          ${r?.airline?.name ? `<dt>Airline</dt><dd>${F.escapeHtml(r.airline.name)}${r.airline.iata ? ` (${F.escapeHtml(r.airline.iata)})` : ''}</dd>` : ''}
        </dl>
      </div>
      <div class="d-foot" id="d-foot"></div>
    </div>`;

  panel.hidden = false;
  $('#btn-close').onclick = deselect;
  $('#btn-follow').onclick = () => setFollow(!state.follow);
  if (!NATIVE) $('#btn-share').onclick = async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      toast('Link copied — anyone with it will see this flight.');
    } catch {
      toast(location.href);
    }
  };
  updateLiveDetails();
  renderProfile();
  updateMapPadding();
}

function stat(label, value, sub = '', swatch = '') {
  return `<div class="stat"><div class="label">${label}</div><div class="value">${swatch ? `<span class="swatch" style="background:${swatch}"></span>` : ''}${value}</div><div class="sub">${sub}</div></div>`;
}

function updateLiveDetails() {
  if (state.selectedShip) return updateShipLive();
  const ac = state.selected && state.aircraft.get(state.selected);
  const live = $('#d-live');
  if (!ac || !live) return;
  const [la, lo] = currentPosition(ac);
  const vsArrow = ac.v > 250 ? '↑ ' : ac.v < -250 ? '↓ ' : '';
  live.innerHTML = [
    stat('Altitude', F.fmtAltitude(ac.a, ac.g), F.fmtAltitudeAlt(ac.a, ac.g), F.altitudeColor(ac.a, ac.g)),
    stat('Ground speed', F.fmtSpeed(ac.s), F.fmtSpeedAlt(ac.s)),
    stat('Vertical speed', `${vsArrow}${F.fmtVerticalRate(ac.v)}`, ac.v === null ? '' : Math.abs(ac.v) < 250 ? 'Level' : ac.v > 0 ? 'Climbing' : 'Descending'),
    stat('Track', F.fmtHeading(ac.k)),
    stat('GPS altitude', ac.ag === null ? '—' : F.fmtAltitude(ac.ag, false)),
    stat('Squawk', F.escapeHtml(ac.q || '—'), ac._em ? F.EMERGENCY_SQUAWKS[ac.q] : ''),
    `<div class="stat" style="grid-column: span 2"><div class="label">Position</div><div class="value" style="font-size:14px;font-family:var(--mono)">${F.fmtCoord(la, lo)}</div></div>`,
  ].join('');

  const p = routeProgress(ac, state.route);
  if (p && $('#rp-fill')) {
    $('#rp-fill').style.width = `${p.fraction * 100}%`;
    $('#rp-plane').style.left = `${p.fraction * 100}%`;
    $('#rp-flown').textContent = `${F.fmtDistance(p.flown)} flown`;
    $('#rp-left').textContent = `${F.fmtDistance(p.remaining)} to go`;
    if (p.etaHours !== null && !ac.g) {
      const eta = new Date(Date.now() + p.etaHours * 3600000);
      $('#rp-eta').textContent = `ETA ~${eta.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (${F.fmtDuration(p.etaHours)})`;
    } else {
      $('#rp-eta').textContent = '';
    }
    $('#rp-note').textContent = p.plausible
      ? `Route via ${state.route.source}. ETA is estimated from current speed.`
      : `⚠ The aircraft is off this route — the route database (${state.route.source}) may be outdated for this callsign.`;
  }

  const foot = $('#d-foot');
  if (foot) {
    const age = Date.now() - ac.ts;
    const lost = state.selectedMissingSince && Date.now() - state.selectedMissingSince > SIGNAL_LOST_MS;
    foot.innerHTML = `${lost ? '<b style="color:var(--danger)">Signal lost.</b> ' : ''}Position reported ${F.fmtAge(age)}${age > 30000 && !ac.g ? ' (shown position is estimated)' : ''} · Source: ${F.escapeHtml(ac.src)}`;
  }
}

/** Small altitude-vs-time line chart for the selected aircraft, with a hover readout. */
function renderProfile() {
  const box = $('#d-profile');
  if (!box) return;
  const pts = selectedTrailPoints().filter((p) => p[2] !== null);
  if (pts.length < 3) {
    box.innerHTML = '<div class="profile-empty">Collecting data… the profile grows as the flight is tracked.</div>';
    return;
  }
  const W = 340;
  const H = 90;
  const padL = 34;
  const padB = 16;
  const t0 = pts[0][3];
  const t1 = pts[pts.length - 1][3];
  const alts = pts.map((p) => Math.max(0, p[2]));
  const top = Math.max(5000, Math.ceil(Math.max(...alts) / 5000) * 5000);
  const x = (t) => padL + ((t - t0) / Math.max(1, t1 - t0)) * (W - padL - 4);
  const y = (a) => 4 + (1 - Math.max(0, a) / top) * (H - padB - 4);
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p[3]).toFixed(1)},${y(p[2]).toFixed(1)}`).join('');
  const metric = F.UNIT_SYSTEMS[F.getUnits()].alt === 'm';
  const fmtTick = (ft) => (metric ? `${Math.round(ft * 0.3048 / 100) / 10}k m` : `${ft / 1000}k`);
  const ticks = [0, top / 2, top];
  const durationMin = Math.round((t1 - t0) / 60000);

  box.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Altitude over the last ${durationMin} minutes">
      <defs><linearGradient id="profile-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffc21a" stop-opacity=".25"/><stop offset="1" stop-color="#ffc21a" stop-opacity="0"/></linearGradient></defs>
      ${ticks.map((t) => `<line class="grid" x1="${padL}" x2="${W}" y1="${y(t)}" y2="${y(t)}"/><text class="axis" x="${padL - 6}" y="${y(t) + 3}" text-anchor="end">${t ? fmtTick(t) : '0'}</text>`).join('')}
      <text class="axis" x="${padL}" y="${H - 2}">−${durationMin} min</text>
      <text class="axis" x="${W - 4}" y="${H - 2}" text-anchor="end">now</text>
      <path class="area" d="${path}L${x(t1)},${y(0)}L${x(t0)},${y(0)}Z"/>
      <path class="line" d="${path}"/>
      <line class="cross" id="pf-cross" y1="4" y2="${H - padB}" visibility="hidden"/>
      <circle class="dot" id="pf-dot" r="4" visibility="hidden"/>
    </svg>
    <div class="profile-tip" id="pf-tip" hidden></div>`;

  const svg = box.querySelector('svg');
  const cross = box.querySelector('#pf-cross');
  const dot = box.querySelector('#pf-dot');
  const tip = box.querySelector('#pf-tip');
  svg.addEventListener('pointermove', (e) => {
    const rect = svg.getBoundingClientRect();
    const sx = ((e.clientX - rect.left) / rect.width) * W;
    const t = t0 + ((sx - padL) / (W - padL - 4)) * (t1 - t0);
    let best = pts[0];
    for (const p of pts) if (Math.abs(p[3] - t) < Math.abs(best[3] - t)) best = p;
    const px = x(best[3]);
    cross.setAttribute('x1', px);
    cross.setAttribute('x2', px);
    dot.setAttribute('cx', px);
    dot.setAttribute('cy', y(best[2]));
    cross.setAttribute('visibility', 'visible');
    dot.setAttribute('visibility', 'visible');
    tip.hidden = false;
    tip.style.left = `${(px / W) * 100}%`;
    tip.textContent = `${F.fmtAltitude(best[2], best[2] === -1)} · ${new Date(best[3]).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  });
  svg.addEventListener('pointerleave', () => {
    cross.setAttribute('visibility', 'hidden');
    dot.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  });
}
setInterval(() => {
  if (state.selected) {
    renderProfile();
    renderSelectionOverlays();
  }
}, 15000);

// ---------------------------------------------------------------------------
// Ships (AIS)
// ---------------------------------------------------------------------------

function shipPosition(ship, now = Date.now()) {
  const age = now - ship.ts;
  if (isStopped(ship) || ship.c === null || !ship.s || age <= 0) return [ship.la, ship.lo];
  return F.project(ship.la, ship.lo, ship.c, (ship.s * Math.min(age, SHIP_EXTRAPOLATE_MS)) / 3600000);
}

function shipFeature(ship, now) {
  const [la, lo] = shipPosition(ship, now);
  const stopped = isStopped(ship);
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lo, la] },
    properties: {
      id: ship.id,
      n: ship.n || ship.id,
      icon: 'ship',
      col: shipColor(ship),
      st: stopped ? 1 : 0,
      sz: shipSize(ship) * (stopped ? 0.85 : 1),
      k: ship.h ?? ship.c ?? 0,
    },
  };
}

function rememberShipPosition(ship) {
  let trail = state.shipTrails.get(ship.id);
  if (!trail) state.shipTrails.set(ship.id, (trail = []));
  const last = trail[trail.length - 1];
  if (last && (last[2] >= ship.ts || (last[0] === ship.lo && last[1] === ship.la))) return;
  trail.push([ship.lo, ship.la, ship.ts]);
  if (trail.length > SHIP_TRAIL_POINTS) trail.splice(0, trail.length - SHIP_TRAIL_POINTS);
}

function adoptShip(ship) {
  if (!ship._clock) {
    ship.ts += state.clockOffset;
    ship._clock = true;
  }
  rememberShipPosition(ship);
  return ship;
}

function ingestShips(list) {
  const next = new Map();
  for (const ship of list) next.set(ship.id, adoptShip(ship));
  if (state.selectedShip && !next.has(state.selectedShip) && state.ships.has(state.selectedShip)) {
    next.set(state.selectedShip, state.ships.get(state.selectedShip));
  }
  state.ships = next;
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, trail] of state.shipTrails) if (!next.has(id) && trail[trail.length - 1][2] < cutoff) state.shipTrails.delete(id);
}

let shipTimer = null;
let shipController = null;

async function pollShips() {
  clearTimeout(shipTimer);
  shipController?.abort();
  const controller = new AbortController();
  shipController = controller;
  try {
    if (!state.settings.ships) {
      state.shipNotices = [];
      ingestShips([]);
    } else if (map.getZoom() < SHIP_MIN_ZOOM) {
      state.shipNotices = ['Zoom in to see ships.'];
      ingestShips([]);
    } else {
      const qs = new URLSearchParams(Object.entries(viewBox()).map(([k, v]) => [k, v.toFixed(3)]));
      const data = await api(`/api/ships?${qs}`, { signal: controller.signal });
      state.shipSources = data.sources || [];
      state.shipNotices = data.notices || [];
      ingestShips(data.ships || []);
      if (state.selectedShip && !(data.ships || []).some((x) => x.id === state.selectedShip)) {
        const d = await api(`/api/ship/${state.selectedShip}`, { signal: controller.signal }).catch(() => null);
        if (d?.ship) state.ships.set(d.ship.id, adoptShip(d.ship));
      }
    }
    render(true);
    if (state.selectedShip) renderSelectionOverlays();
  } catch (err) {
    if (err.name === 'AbortError') return;
    state.shipNotices = [`Ships: ${err.message}`];
  } finally {
    updateShipHint();
    if (shipController === controller) {
      shipController = null;
      state.shipsPolled = true;
      Splash.step('ships', state.shipNotices.length && !state.ships.size ? 'warn' : 'ok', state.ships.size ? `${F.fmtNumber(state.ships.size)} ships` : state.shipNotices[0] || 'Ready');
      shipTimer = setTimeout(pollShips, document.hidden ? POLL_HIDDEN_MS : POLL_SHIPS_MS);
    }
  }
}

/** Small chip on the map explaining why no ships are visible (zoom level, feed connecting, errors). */
function updateShipHint() {
  const el = $('#ship-hint');
  if (!el) return;
  let text = '';
  if (state.settings.ships && !state.ships.size) {
    if (map.getZoom() < SHIP_MIN_ZOOM) text = 'Zoom in to see ships';
    else if (state.shipNotices.length) text = state.shipNotices[0].replace(/\.$/, '');
    else text = 'No ships reported here yet';
  }
  el.hidden = !text;
  el.querySelector('span').textContent = text;
}

function shipTrailFeatures(ship) {
  const trail = [...(state.shipTrails.get(ship.id) || [])];
  const [la, lo] = shipPosition(ship);
  trail.push([lo, la, Date.now()]);
  if (trail.length < 2) return [];
  return [{ type: 'Feature', geometry: { type: 'LineString', coordinates: trail.map(([x, y]) => [x, y]) }, properties: { color: shipColor(ship) } }];
}

function selectShip(id, { fly = false, follow = false } = {}) {
  selectToken++;
  state.selected = null;
  state.selectedAirport = null;
  state.route = null;
  state.track = [];
  state.selectedShip = String(id);
  setFollow(follow);
  applySelectionFilter();
  renderShipDetails();
  render(true);
  renderSelectionOverlays();
  updateUrl();
  const ship = state.ships.get(state.selectedShip);
  if (fly && ship) {
    const [la, lo] = shipPosition(ship);
    map.flyTo({ center: [lo, la], zoom: Math.max(map.getZoom(), 9), speed: 1.4, essential: true });
  }
}

function renderShipDetails() {
  const panel = $('#details');
  const ship = state.ships.get(state.selectedShip);
  if (!ship) {
    panel.hidden = true;
    updateMapPadding();
    return;
  }
  const category = SHIP_CATEGORIES[shipCategory(ship.t)];
  const badges = [`<span class="badge"><span class="swatch-dot" style="background:${category.color}"></span>${F.escapeHtml(category.label)}</span>`];
  if (ship.ns === 14) badges.push('<span class="badge danger">AIS-SART emergency beacon</span>');
  else if (NAV_STATUS[ship.ns]) badges.push(`<span class="badge">${F.escapeHtml(NAV_STATUS[ship.ns])}</span>`);
  const size = ship.l ? `${ship.l} × ${ship.w ?? '?'} m` : '—';
  panel.innerHTML = `
    <div class="d-head">
      <div class="d-head-top">
        <div>
          <div class="d-callsign">${F.escapeHtml(ship.n || `MMSI ${ship.id}`)}</div>
          <div class="d-airline">${F.escapeHtml(shipTypeName(ship.t))} · MMSI ${ship.id}</div>
        </div>
        <div class="d-actions">
          <button class="icon-btn ${state.follow ? 'active' : ''}" id="btn-follow" title="Follow (F)" aria-label="Follow this ship">${ICON_SVG.follow}</button>
          <button class="icon-btn" id="btn-close" title="Close (Esc)" aria-label="Close">${ICON_SVG.close}</button>
        </div>
      </div>
      <div class="badges">${badges.join('')}</div>
    </div>
    <div class="d-scroll">
      <div class="d-route">
        ${ship.d
          ? `<div class="voyage"><div class="voyage-label">Destination</div><div class="voyage-dest">${F.escapeHtml(ship.d)}</div>
             ${ship.eta ? `<div class="voyage-eta">ETA ${F.escapeHtml(ship.eta)} UTC <span>(reported by the crew)</span></div>` : ''}</div>`
          : '<div class="route-unknown">No destination reported.</div>'}
      </div>
      <div class="d-section">
        <h4>Live data</h4>
        <div class="stat-grid" id="d-live"></div>
      </div>
      <div class="d-section">
        <h4>Vessel</h4>
        <dl class="kv">
          <dt>Type</dt><dd>${F.escapeHtml(shipTypeName(ship.t))}${ship.t ? ` <span class="mono">(${ship.t})</span>` : ''}</dd>
          <dt>MMSI</dt><dd class="mono">${ship.id}</dd>
          <dt>IMO</dt><dd class="mono">${ship.imo || '—'}</dd>
          <dt>Call sign</dt><dd class="mono">${F.escapeHtml(ship.cs || '—')}</dd>
          <dt>Length × beam</dt><dd>${size}</dd>
          <dt>Draught</dt><dd>${ship.dr ? `${ship.dr} m` : '—'}</dd>
        </dl>
      </div>
      <div class="d-foot" id="d-foot"></div>
    </div>`;
  panel.hidden = false;
  $('#btn-close').onclick = deselect;
  $('#btn-follow').onclick = () => setFollow(!state.follow);
  updateShipLive();
  updateMapPadding();
}

function updateShipLive() {
  const ship = state.ships.get(state.selectedShip);
  const live = $('#d-live');
  if (!ship || !live) return;
  const [la, lo] = shipPosition(ship);
  live.innerHTML = [
    stat('Speed', ship.s === null ? '—' : `${ship.s.toFixed(1)} kn`, ship.s === null ? '' : `${F.fmtNumber(ship.s * 1.852)} km/h`),
    stat('Course', F.fmtHeading(ship.c)),
    stat('Heading', F.fmtHeading(ship.h)),
    stat('Status', F.escapeHtml(NAV_STATUS[ship.ns] || '—')),
    `<div class="stat" style="grid-column: span 2"><div class="label">Position</div><div class="value" style="font-size:14px;font-family:var(--mono)">${F.fmtCoord(la, lo)}</div></div>`,
  ].join('');
  const foot = $('#d-foot');
  if (foot) {
    const age = Date.now() - ship.ts;
    foot.innerHTML = `Position reported ${F.fmtAge(age)}${age > 120000 && !isStopped(ship) ? ' (shown position is estimated)' : ''} · Source: ${F.escapeHtml(ship.src)}`;
  }
}

// ---------------------------------------------------------------------------
// Airports (bundled list from the offline map package)
// ---------------------------------------------------------------------------

let airportIndex = new Map();

async function loadAirports() {
  try {
    const res = await fetch(assetUrl('map/airports.json'));
    if (!res.ok) throw new Error(res.status);
    state.airports = await res.json();
    airportIndex = new Map(state.airports.map((a) => [a.icao, a]));
  } catch {
    state.builtinAvailable = false; // offline map package not built (website without `npm run basemap`)
    document.querySelector('[data-style="builtin"]')?.remove();
    if (state.settings.style === 'builtin') setMapStyle('dark');
  }
}

const airportByIcao = (icao) => (icao ? airportIndex.get(icao) : null);

function selectAirport(icao, { fly = false } = {}) {
  const airport = airportByIcao(icao);
  if (!airport) return;
  selectToken++;
  state.selected = null;
  state.selectedShip = null;
  state.selectedAirport = icao;
  setFollow(false);
  applySelectionFilter();
  render(true);
  renderSelectionOverlays();
  renderAirportDetails();
  if (fly) map.flyTo({ center: [airport.lon, airport.lat], zoom: Math.max(map.getZoom(), 9.5), essential: true });
}

/** Aircraft within 40 nm of the airport, low and slow first (most likely arriving / departing). */
function aircraftNearAirport(airport) {
  const near = [];
  for (const ac of state.aircraft.values()) {
    const [la, lo] = currentPosition(ac);
    const d = F.distanceNm(airport.lat, airport.lon, la, lo);
    if (d <= 40 && (ac.g || (ac.a ?? 99999) < 15000)) near.push([d, ac]);
  }
  return near.sort((a, b) => a[0] - b[0]).slice(0, 12);
}

function renderAirportDetails() {
  const panel = $('#details');
  const a = airportByIcao(state.selectedAirport);
  if (!a) {
    panel.hidden = true;
    updateMapPadding();
    return;
  }
  const near = aircraftNearAirport(a);
  panel.innerHTML = `
    <div class="d-head">
      <div class="d-head-top">
        <div>
          <div class="d-callsign">${F.escapeHtml(a.iata || a.icao)}${a.iata ? `<span class="d-flightno">${F.escapeHtml(a.icao)}</span>` : ''}</div>
          <div class="d-airline">${F.escapeHtml(a.name)}</div>
        </div>
        <div class="d-actions"><button class="icon-btn" id="btn-close" title="Close (Esc)" aria-label="Close">${ICON_SVG.close}</button></div>
      </div>
      <div class="badges"><span class="badge">${a.large ? 'Major airport' : 'Regional airport'}</span></div>
    </div>
    <div class="d-scroll">
      <div class="d-section">
        <dl class="kv">
          <dt>City</dt><dd>${F.escapeHtml(a.city || '—')}</dd>
          <dt>Country</dt><dd>${F.escapeHtml(a.country || '—')}</dd>
          <dt>Elevation</dt><dd>${a.elev === null ? '—' : F.fmtAltitude(a.elev, false)}</dd>
          <dt>Position</dt><dd class="mono">${F.fmtCoord(a.lat, a.lon)}</dd>
          <dt>Local time</dt><dd>${Extras.solarTimeText(a.lon)}</dd>
          <dt>Sun</dt><dd>${Extras.isDaylight(a.lat, a.lon) ? '☀︎ Daylight' : '☾ Night'}</dd>
        </dl>
      </div>
      <div class="d-section">
        <h4>Arriving &amp; departing nearby (${near.length})</h4>
        ${near.length ? `<div class="near-list">${near.map(([d, ac]) => `
          <button class="near-item" data-hex="${ac.h}">
            <img src="${iconDataUrl(ac._icon, F.altitudeColor(ac.a, ac.g))}" alt="">
            <span class="near-name">${F.escapeHtml(ac.c || ac.r || ac.h.toUpperCase())}${ac._fn ? ` <small>${ac._fn}</small>` : ''}</span>
            <span class="near-meta">${F.fmtAltitude(ac.a, ac.g)} · ${F.fmtDistance(d)}</span>
          </button>`).join('')}</div>` : '<div class="profile-empty">No aircraft close to the airport right now (zoom in near it to load live traffic).</div>'}
      </div>
      ${a.wiki ? `<div class="d-foot"><a href="${F.escapeHtml(a.wiki)}" target="_blank" rel="noopener">Wikipedia ↗</a> · Data: OurAirports</div>` : '<div class="d-foot">Data: OurAirports</div>'}
    </div>`;
  panel.hidden = false;
  $('#btn-close').onclick = deselect;
  panel.querySelectorAll('.near-item').forEach((b) => b.addEventListener('click', () => selectAircraft(b.dataset.hex, { fly: true })));
  updateMapPadding();
}

// ---------------------------------------------------------------------------
// Map interaction: click to select, hover tooltip
// ---------------------------------------------------------------------------

/** Nearest rendered feature of the given layers around a screen point; returns one of its properties. */
function featureAt(point, radius, layers, key) {
  if (!layers.every((l) => map.getLayer(l))) return null;
  const features = map.queryRenderedFeatures([[point.x - radius, point.y - radius], [point.x + radius, point.y + radius]], { layers });
  if (!features.length) return null;
  let best = features[0];
  let bestD = Infinity;
  for (const f of features) {
    const p = map.project(f.geometry.coordinates);
    const dd = (p.x - point.x) ** 2 + (p.y - point.y) ** 2;
    if (dd < bestD) {
      bestD = dd;
      best = f;
    }
  }
  return best.properties[key];
}

const aircraftAt = (point, radius = 8) => featureAt(point, radius, ['aircraft-icons'], 'h');
const shipAt = (point, radius = 8) => (state.settings.ships ? featureAt(point, radius, ['ship-icons'], 'id') : null);
const airportAt = (point, radius = 8) => {
  if (!state.settings.airports) return null;
  const layers = ['airport-dots-large', 'airport-dots-small'].filter((l) => map.getLayer(l));
  return layers.length ? featureAt(point, radius, layers, 'icao') : null;
};

selectedEl.addEventListener('click', (e) => {
  e.stopPropagation();
  setFollow(!state.follow);
});

map.on('click', (e) => {
  const radius = matchMedia('(pointer: coarse)').matches ? 16 : 8;
  const hex = aircraftAt(e.point, radius);
  const shipId = !hex && shipAt(e.point, radius);
  const icao = !hex && !shipId && airportAt(e.point, radius);
  if (hex) selectAircraft(hex);
  else if (shipId) selectShip(shipId);
  else if (icao) selectAirport(icao);
  else if (state.selected || state.selectedShip || state.selectedAirport) deselect();
  closePopovers();
});

const tooltip = $('#tooltip');
map.on('mousemove', (e) => {
  const hex = aircraftAt(e.point, 6);
  const ac = hex && state.aircraft.get(hex);
  const ship = !ac && state.ships.get(shipAt(e.point, 6));
  const airport = !ac && !ship && airportByIcao(airportAt(e.point, 6));
  map.getCanvas().style.cursor = ac || ship || airport ? 'pointer' : '';
  if (ship || airport) {
    tooltip.innerHTML = ship
      ? `<div class="tt-title">${F.escapeHtml(ship.n || `MMSI ${ship.id}`)}</div>
        <div class="tt-sub">${F.escapeHtml(shipTypeName(ship.t))}${ship.d ? ` → ${F.escapeHtml(ship.d)}` : ''}</div>
        <div class="tt-sub">${ship.s === null ? '—' : `${ship.s.toFixed(1)} kn`} · ${F.escapeHtml(NAV_STATUS[ship.ns] || '')}</div>`
      : `<div class="tt-title">${F.escapeHtml(airport.iata || airport.icao)} · ${F.escapeHtml(airport.name)}</div>
        <div class="tt-sub">${F.escapeHtml([airport.city, airport.country].filter(Boolean).join(', '))}</div>`;
    tooltip.style.left = `${e.originalEvent.clientX}px`;
    tooltip.style.top = `${e.originalEvent.clientY}px`;
    tooltip.hidden = false;
    return;
  }
  if (!ac) {
    tooltip.hidden = true;
    return;
  }
  const name = ac.c || ac.r || ac.h.toUpperCase();
  tooltip.innerHTML = `<div class="tt-title">${F.escapeHtml(name)}${ac._fn ? ` <span class="tt-sub">${ac._fn}</span>` : ''}</div>
    <div class="tt-sub">${F.escapeHtml([ac.t, ac._airline?.name || ac.o].filter(Boolean).join(' · ') || 'Unknown type')}</div>
    <div class="tt-sub">${F.fmtAltitude(ac.a, ac.g)} · ${F.fmtSpeed(ac.s)}</div>`;
  tooltip.style.left = `${e.originalEvent.clientX}px`;
  tooltip.style.top = `${e.originalEvent.clientY}px`;
  tooltip.hidden = false;
});
map.getCanvas().addEventListener('mouseleave', () => { tooltip.hidden = true; });

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

const searchInput = $('#search-input');
const searchBox = $('.search');
const resultsEl = $('#search-results');
let searchItems = []; // [{ action: () => void }]
let activeIndex = -1;
let searchToken = 0;

const GLOBE_SVG = '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm0 2a8 8 0 0 0-7.75 6h3.4c.2-2.2.8-4.2 1.7-5.6A8 8 0 0 0 12 4zm0 0c-1 1.3-1.9 3.4-2.1 6h4.2c-.2-2.6-1.1-4.7-2.1-6zm2.65.4c.9 1.4 1.5 3.4 1.7 5.6h3.4a8 8 0 0 0-5.1-5.6zM4.25 14a8 8 0 0 0 5.1 5.6c-.9-1.4-1.5-3.4-1.7-5.6zm5.65 0c.2 2.6 1.1 4.7 2.1 6 1-1.3 1.9-3.4 2.1-6zm6.45 0c-.2 2.2-.8 4.2-1.7 5.6a8 8 0 0 0 5.1-5.6z"/></svg>';

function resultRow(ac) {
  const icon = iconDataUrl(ac._icon || 'airliner', F.altitudeColor(ac.a, ac.g));
  const name = ac.c || ac.r || ac.h.toUpperCase();
  const sub = [ac._airline?.name || ac.o, ac.t || ac.d, ac.r && ac.r !== name ? ac.r : ''].filter(Boolean).join(' · ') || ac.h.toUpperCase();
  return `<span class="sr-icon"><img src="${icon}" alt=""></span>
    <span class="sr-main"><span class="sr-title">${F.escapeHtml(name)}${ac._fn && ac._fn !== name ? `<small>${ac._fn}</small>` : ''}</span><span class="sr-sub">${F.escapeHtml(sub)}</span></span>
    <span class="sr-meta">${ac.g ? 'GND' : ac.a !== null ? `${F.fmtAltitude(ac.a)}` : ''}</span>`;
}

function showResults(html, items) {
  resultsEl.innerHTML = html;
  searchItems = items;
  activeIndex = -1;
  resultsEl.hidden = false;
  searchBox.setAttribute('aria-expanded', 'true');
  resultsEl.querySelectorAll('.sr-item').forEach((el, i) => {
    el.addEventListener('mousedown', (e) => e.preventDefault());
    el.addEventListener('click', () => items[i].action());
  });
}

function hideResults() {
  resultsEl.hidden = true;
  searchBox.setAttribute('aria-expanded', 'false');
  activeIndex = -1;
}

function localMatches(query) {
  const q = query.toUpperCase().replace(/\s+/g, '');
  if (!q) return [];
  const exact = new Set(callsignCandidates(q));
  const qNoDash = q.replace(/-/g, '');
  const scored = [];
  for (const ac of state.aircraft.values()) {
    const cs = ac.c.toUpperCase();
    const reg = ac.r.toUpperCase().replace(/-/g, '');
    let score = 0;
    if (exact.has(cs) || ac._fn === q) score = 100;
    else if (reg && reg === qNoDash) score = 95;
    else if (ac.h.toUpperCase() === q) score = 90;
    else if (cs.startsWith(q) || ac._fn?.startsWith(q)) score = 60 - cs.length;
    else if (reg && reg.startsWith(qNoDash)) score = 40;
    else if (q.length >= 3 && ac.h.toUpperCase().startsWith(q)) score = 30;
    else if (q.length >= 3 && ac.t === q) score = 20;
    if (score) scored.push([score, ac]);
  }
  return scored.sort((a, b) => b[0] - a[0]).slice(0, 8).map(([, ac]) => ac);
}

function localShipMatches(query) {
  const q = query.trim().toUpperCase();
  if (q.length < 3) return [];
  const out = [];
  for (const ship of state.ships.values()) {
    if (ship.id === q || String(ship.imo) === q || ship.cs.toUpperCase() === q || ship.n.toUpperCase().includes(q)) out.push(ship);
    if (out.length >= 5) break;
  }
  return out;
}

function localAirportMatches(query) {
  const q = query.trim().toUpperCase();
  if (q.length < 3) return [];
  const exact = [];
  const partial = [];
  for (const a of state.airports) {
    if (a.iata === q || a.icao === q) exact.push(a);
    else if (q.length >= 4 && (a.name.toUpperCase().includes(q) || a.city.toUpperCase().startsWith(q))) partial.push(a);
    if (exact.length + partial.length >= 40) break;
  }
  return [...exact, ...partial.sort((x, y) => y.large - x.large)].slice(0, 4);
}

function shipResultRow(ship) {
  const icon = iconDataUrl('ship', shipColor(ship));
  const sub = [shipTypeName(ship.t), ship.d ? `→ ${ship.d}` : '', `MMSI ${ship.id}`].filter(Boolean).join(' · ');
  return `<span class="sr-icon"><img src="${icon}" alt="" style="transform:none"></span>
    <span class="sr-main"><span class="sr-title">${F.escapeHtml(ship.n || `MMSI ${ship.id}`)}</span><span class="sr-sub">${F.escapeHtml(sub)}</span></span>
    <span class="sr-meta">${ship.s === null ? '' : `${ship.s.toFixed(1)} kn`}</span>`;
}

function airportResultRow(a) {
  return `<span class="sr-icon sr-airport">${a.iata || a.icao}</span>
    <span class="sr-main"><span class="sr-title">${F.escapeHtml(a.name)}</span><span class="sr-sub">${F.escapeHtml([a.city, a.country].filter(Boolean).join(', '))} · ${a.icao}</span></span>
    <span class="sr-meta">Airport</span>`;
}

function pickShip(ship) {
  hideResults();
  searchInput.blur();
  state.ships.set(ship.id, adoptShip(ship));
  selectShip(ship.id, { fly: true, follow: true });
}

function pickAirport(a) {
  hideResults();
  searchInput.blur();
  selectAirport(a.icao, { fly: true });
}

function pickResult(ac) {
  hideResults();
  searchInput.blur();
  upsert([ac]);
  selectAircraft(ac.h, { fly: true, follow: true });
}

function suggest() {
  const q = searchInput.value.trim();
  if (!q) {
    hideResults();
    return;
  }
  const matches = localMatches(q);
  const ships = localShipMatches(q);
  const airports = localAirportMatches(q);
  let html = '';
  const items = [];
  const section = (title, list, row, pick) => {
    if (!list.length) return;
    html += `<div class="sr-section">${title}</div>`;
    for (const x of list) {
      html += `<button class="sr-item" role="option">${row(x)}</button>`;
      items.push({ action: () => pick(x) });
    }
  };
  section('Flights on the map', matches, resultRow, pickResult);
  section('Ships on the map', ships, shipResultRow, pickShip);
  section('Airports', airports, airportResultRow, pickAirport);
  html += `<button class="sr-item sr-global" role="option"><span class="sr-icon">${GLOBE_SVG}</span><span class="sr-main"><span class="sr-title">Search worldwide for “${F.escapeHtml(q)}”</span><span class="sr-sub">Flight number, callsign, registration, ship name, MMSI or IMO</span></span><span class="sr-meta">Enter ↵</span></button>`;
  items.push({ action: () => globalSearch(q) });
  showResults(html, items);
}

async function globalSearch(query) {
  const q = query.trim();
  if (!q) return;
  const token = ++searchToken;
  showResults(`<div class="sr-empty" style="display:flex;gap:10px;align-items:center"><span class="spinner"></span> Searching live traffic worldwide for “${F.escapeHtml(q)}”…</div>`, []);
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(q)}`);
    if (token !== searchToken) return;
    const list = (data.aircraft || []).map((ac) => enrich(ac));
    const ships = data.ships || [];
    const airports = localAirportMatches(q);
    const total = list.length + ships.length + airports.length;
    if (!total) {
      showResults(`<div class="sr-empty"><b>Nothing live found for “${F.escapeHtml(q)}”.</b><br>A flight may not have departed yet or may be outside receiver coverage; a ship may be out of AIS range. Try a callsign (e.g. <b>BAW117</b>), registration (<b>G-XLEA</b>), ship name, MMSI or an airport code (<b>LHR</b>).</div>`, []);
      return;
    }
    if (total === 1) {
      if (list.length) pickResult(list[0]);
      else if (ships.length) pickShip(ships[0]);
      else pickAirport(airports[0]);
      return;
    }
    let html = '';
    const items = [];
    const section = (title, items_, row, pick) => {
      if (!items_.length) return;
      html += `<div class="sr-section">${title}</div>`;
      for (const x of items_) {
        html += `<button class="sr-item" role="option">${row(x)}</button>`;
        items.push({ action: () => pick(x) });
      }
    };
    section(`${list.length} live flight${list.length === 1 ? '' : 's'}`, list, resultRow, pickResult);
    section(`${ships.length} ship${ships.length === 1 ? '' : 's'}`, ships, shipResultRow, pickShip);
    section('Airports', airports, airportResultRow, pickAirport);
    showResults(html, items);
  } catch (err) {
    if (token !== searchToken) return;
    showResults(`<div class="sr-empty">Search failed: ${F.escapeHtml(err.message)}</div>`, []);
  }
}

let suggestTimer = null;
searchInput.addEventListener('input', () => {
  clearTimeout(suggestTimer);
  suggestTimer = setTimeout(suggest, 120);
});
searchInput.addEventListener('focus', () => {
  if (searchInput.value.trim()) suggest();
});
searchInput.addEventListener('blur', () => setTimeout(hideResults, 150));
searchInput.addEventListener('keydown', (e) => {
  const rows = [...resultsEl.querySelectorAll('.sr-item')];
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!rows.length) return;
    activeIndex = (activeIndex + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
    rows.forEach((r, i) => r.setAttribute('aria-selected', String(i === activeIndex)));
    rows[activeIndex].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (activeIndex >= 0 && searchItems[activeIndex]) searchItems[activeIndex].action();
    else {
      // An exact match on the map wins; otherwise search the world.
      const exact = localMatches(searchInput.value).find((ac) => callsignCandidates(searchInput.value).includes(ac.c.toUpperCase()) || ac._fn === searchInput.value.toUpperCase().replace(/\s+/g, ''));
      if (exact) pickResult(exact);
      else globalSearch(searchInput.value);
    }
  } else if (e.key === 'Escape') {
    hideResults();
    searchInput.blur();
  }
});

// ---------------------------------------------------------------------------
// Tools, popovers, settings
// ---------------------------------------------------------------------------

function closePopovers(except) {
  document.querySelectorAll('.popover').forEach((p) => {
    if (p.id !== except) p.hidden = true;
  });
  document.querySelectorAll('.tool[data-panel]').forEach((b) => b.classList.toggle('active', `panel-${b.dataset.panel}` === except));
}

document.querySelectorAll('.tool[data-panel]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const panel = $(`#panel-${btn.dataset.panel}`);
    const open = panel.hidden;
    closePopovers(open ? panel.id : undefined);
    panel.hidden = !open;
    if (open && btn.dataset.panel === 'settings') loadDataStatus();
  });
});

function saveSettings() {
  store.set('settings', state.settings);
}

// Map styles
const styleGrid = $('#style-grid');
styleGrid.innerHTML = Object.entries(STYLES).map(([id, s]) =>
  `<button class="style-btn ${state.settings.style === id ? 'active' : ''}" data-style="${id}" style="background:${s.swatch};color:${s.ink ? '#fff' : '#fff'}">${s.name}</button>`).join('');
styleGrid.addEventListener('click', (e) => {
  const id = e.target.closest('[data-style]')?.dataset.style;
  if (!id || id === state.settings.style) return;
  setMapStyle(id);
});

// Overlay switches: ships, airports, day/night, weather radar.
function bindSwitch(id, key, apply) {
  const el = $(id);
  el.checked = state.settings[key];
  el.addEventListener('change', () => {
    state.settings[key] = el.checked;
    saveSettings();
    apply(el.checked);
  });
}
bindSwitch('#opt-ships', 'ships', (on) => {
  if (map.getLayer('ship-icons')) map.setLayoutProperty('ship-icons', 'visibility', on ? 'visible' : 'none');
  if (map.getLayer('ship-labels')) map.setLayoutProperty('ship-labels', 'visibility', on && state.settings.labels ? 'visible' : 'none');
  if (!on && state.selectedShip) deselect();
  pollShips();
});
bindSwitch('#opt-airports', 'airports', (on) => Extras.setBaseAirports(map, on));
bindSwitch('#opt-daynight', 'daynight', (on) => Extras.setDayNight(map, on));
// Weather: Rain radar / Clouds / Off, opacity, and a one-tap on/off button on the map toolbar.
let lastWeatherMode = state.settings.weatherMode !== 'off' ? state.settings.weatherMode : 'radar';

function weatherStatus(time, err) {
  const el = $('#weather-status');
  if (err) el.textContent = `Weather unavailable: ${err.message}`;
  else if (time) el.textContent = `${state.settings.weatherMode === 'clouds' ? 'Satellite image' : 'Radar'} from ${time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · RainViewer`;
  else el.textContent = state.settings.weatherMode === 'off' ? 'Weather overlay is off.' : 'Loading…';
}

function syncWeatherUi() {
  const mode = state.settings.weatherMode;
  document.querySelectorAll('#weather-modes button').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === mode);
    b.setAttribute('aria-checked', String(b.dataset.mode === mode));
  });
  $('#weather-opacity').value = state.settings.weatherOpacity;
  $('#weather-opacity').disabled = mode === 'off';
  $('#weather-legend').hidden = mode !== 'radar';
  $('#btn-weather').classList.toggle('active', mode !== 'off');
  $('#btn-weather').setAttribute('aria-pressed', String(mode !== 'off'));
}

function setWeatherMode(mode) {
  state.settings.weatherMode = mode;
  if (mode !== 'off') lastWeatherMode = mode;
  saveSettings();
  syncWeatherUi();
  weatherStatus(null);
  Extras.setWeather(map, mode).then((time) => weatherStatus(time), (err) => {
    weatherStatus(null, err);
    toast(`Weather unavailable: ${err.message}`, true);
  });
}

$('#weather-modes').addEventListener('click', (e) => {
  const mode = e.target.closest('[data-mode]')?.dataset.mode;
  if (mode && mode !== state.settings.weatherMode) setWeatherMode(mode);
});
$('#weather-opacity').addEventListener('input', (e) => {
  state.settings.weatherOpacity = Number(e.target.value);
  saveSettings();
  Extras.setWeatherOpacity(map, state.settings.weatherOpacity);
});
$('#btn-weather').addEventListener('click', () => {
  const on = state.settings.weatherMode !== 'off';
  setWeatherMode(on ? 'off' : lastWeatherMode);
  toast(on ? 'Weather overlay off.' : `${lastWeatherMode === 'clouds' ? 'Clouds' : 'Rain radar'} on.`);
});
syncWeatherUi();
weatherStatus(null);
$('#ship-hint').addEventListener('click', () => {
  if (map.getZoom() < SHIP_MIN_ZOOM) map.easeTo({ zoom: SHIP_MIN_ZOOM + 1.5 });
  else pollShips();
});
map.on('zoomend', updateShipHint);
$('#ship-legend').innerHTML = Object.values(SHIP_CATEGORIES).map((c) => `<span><i style="background:${c.color}"></i>${c.label}</span>`).join('');

// Live statistics panel
document.querySelector('[data-panel="stats"]').addEventListener('click', () => renderStats());
setInterval(() => {
  if (!$('#panel-stats').hidden) renderStats();
}, 3000);

function renderStats() {
  Extras.renderStats($('#stats-body'), {
    aircraft: [...state.aircraft.values()].filter(passesFilters),
    ships: state.settings.ships ? [...state.ships.values()] : [],
    onAircraft: (hex) => selectAircraft(hex, { fly: true }),
    onAirline: (prefix) => {
      state.filters.prefix = prefix;
      filtersChanged();
      toast(`Showing only ${prefix} flights – clear it in Filters.`);
    },
    onShip: (id) => selectShip(id, { fly: true }),
    fmtAltitude: F.fmtAltitude,
    fmtSpeed: F.fmtSpeed,
    altitudeColor: F.altitudeColor,
    shipCategory,
    categories: SHIP_CATEGORIES,
  });
}

const optGlobe = $('#opt-globe');
const optLabels = $('#opt-labels');
const optTrails = $('#opt-trails');
optGlobe.checked = state.settings.globe;
optLabels.checked = state.settings.labels;
optTrails.checked = state.settings.trails;
optGlobe.addEventListener('change', () => {
  state.settings.globe = optGlobe.checked;
  saveSettings();
  map.setProjection({ type: optGlobe.checked ? 'globe' : 'mercator' });
});
optLabels.addEventListener('change', () => {
  state.settings.labels = optLabels.checked;
  saveSettings();
  if (map.getLayer('aircraft-labels')) map.setLayoutProperty('aircraft-labels', 'visibility', optLabels.checked ? 'visible' : 'none');
  if (map.getLayer('ship-labels')) map.setLayoutProperty('ship-labels', 'visibility', optLabels.checked && state.settings.ships ? 'visible' : 'none');
});
optTrails.addEventListener('change', () => {
  state.settings.trails = optTrails.checked;
  saveSettings();
  if (map.getLayer('trails-all')) map.setLayoutProperty('trails-all', 'visibility', optTrails.checked ? 'visible' : 'none');
  renderAllTrails();
});

// Filters
const fAltMin = $('#f-alt-min');
const fAltMax = $('#f-alt-max');
const filterInputs = {
  airliners: $('#f-airliners'), light: $('#f-light'), heli: $('#f-heli'), ground: $('#f-ground'), military: $('#f-military'),
};

function syncFilterUi() {
  const f = state.filters;
  fAltMin.value = f.altMin;
  fAltMax.value = f.altMax;
  for (const [key, el] of Object.entries(filterInputs)) el.checked = f[key];
  $('#f-prefix').value = f.prefix;
  const altText = (v) => (F.UNIT_SYSTEMS[F.getUnits()].alt === 'm' ? `${F.fmtNumber(v * 0.3048)} m` : `${F.fmtNumber(v)} ft`);
  $('#f-alt-label').textContent = f.altMin === 0 && f.altMax >= 50000
    ? 'All altitudes'
    : `${altText(f.altMin)} – ${f.altMax >= 50000 ? 'max' : altText(f.altMax)}`;
  const active = JSON.stringify(f) !== JSON.stringify(DEFAULT_FILTERS);
  $('#filter-dot').hidden = !active;
}

function filtersChanged() {
  store.set('filters', state.filters);
  syncFilterUi();
  render(true);
  renderAllTrails();
}

fAltMin.addEventListener('input', () => {
  state.filters.altMin = Math.min(Number(fAltMin.value), state.filters.altMax - 1000);
  filtersChanged();
});
fAltMax.addEventListener('input', () => {
  state.filters.altMax = Math.max(Number(fAltMax.value), state.filters.altMin + 1000);
  filtersChanged();
});
for (const [key, el] of Object.entries(filterInputs)) {
  el.addEventListener('change', () => {
    state.filters[key] = el.checked;
    filtersChanged();
  });
}
$('#f-prefix').addEventListener('input', (e) => {
  state.filters.prefix = e.target.value.toUpperCase().replace(/\s+/g, '');
  filtersChanged();
});
$('#f-reset').addEventListener('click', () => {
  state.filters = { ...DEFAULT_FILTERS };
  filtersChanged();
});
syncFilterUi();

// Units
const unitSelect = $('#unit-select');
unitSelect.innerHTML = Object.entries(F.UNIT_SYSTEMS).map(([id, u]) =>
  `<button data-unit="${id}" class="${state.settings.units === id ? 'active' : ''}">${u.label}</button>`).join('');
unitSelect.addEventListener('click', (e) => {
  const id = e.target.closest('[data-unit]')?.dataset.unit;
  if (!id) return;
  state.settings.units = id;
  F.setUnits(id);
  saveSettings();
  unitSelect.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.unit === id));
  renderLegend();
  syncFilterUi();
  if (state.selected) renderDetails();
});

async function loadDataStatus() {
  const el = $('#data-status');
  try {
    const s = await api('/api/status');
    if (s.demo) {
      el.innerHTML = '<b>Demo mode</b> — simulated traffic. Start the server without <code>DEMO=1</code> for live data.';
      return;
    }
    const o = s.opensky;
    el.innerHTML = `
      Live view: <b>${F.escapeHtml(state.sources.join(' + ') || '—')}</b><br>
      World snapshot (OpenSky): <b>${F.fmtNumber(o.aircraft)}</b> aircraft${o.snapshotAgeSec !== null ? `, ${o.snapshotAgeSec}s old` : ''}<br>
      OpenSky access: <b>${o.authenticated ? 'account' : 'anonymous'}</b>, refresh every ${o.refreshEverySec}s${o.creditsRemaining !== null ? `, ${F.fmtNumber(o.creditsRemaining)} credits left` : ''}
      ${o.blockedForSec ? `<br><span style="color:var(--accent)">Rate-limited, retrying in ${Math.ceil(o.blockedForSec / 60)} min</span>` : ''}
      ${o.lastError ? `<br>Last error: ${F.escapeHtml(o.lastError)}` : ''}
      ${s.ships ? `<br>Ships: <b>${F.fmtNumber(s.ships.ships)}</b> tracked · aisstream.io: <b>${F.escapeHtml(typeof s.ships.aisstream === 'string' ? s.ships.aisstream : s.ships.aisstream.status)}</b> · Digitraffic: <b>${s.ships.digitraffic?.error ? 'unavailable' : 'ok'}</b>` : ''}`;
  } catch (err) {
    el.textContent = `Status unavailable: ${err.message}`;
  }
}

// Locate, world, fullscreen
let meMarker = null;
$('#btn-locate').addEventListener('click', () => {
  if (!navigator.geolocation) return toast('Location is not available in this browser.', true);
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const lngLat = [pos.coords.longitude, pos.coords.latitude];
      if (!meMarker) {
        const el = document.createElement('div');
        el.style.cssText = 'width:14px;height:14px;border-radius:50%;background:#4b8cff;border:3px solid #fff;box-shadow:0 0 0 6px rgba(75,140,255,.25)';
        meMarker = new maplibregl.Marker({ element: el });
      }
      meMarker.setLngLat(lngLat).addTo(map);
      map.flyTo({ center: lngLat, zoom: 8 });
    },
    () => toast('Could not get your location.', true),
    { enableHighAccuracy: false, timeout: 10000 },
  );
});

function showWorld() {
  setFollow(false);
  map.flyTo({ center: [20, 28], zoom: 1.9, pitch: 0, bearing: 0 });
}
$('#btn-world').addEventListener('click', showWorld);
$('#btn-fullscreen').hidden = NATIVE;
$('#btn-fullscreen').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.();
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
  if (e.key === '/' && !typing) {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
  } else if (e.key === 'Escape' && !typing) {
    if (document.querySelector('.popover:not([hidden])')) closePopovers();
    else if (state.selected || state.selectedShip || state.selectedAirport) deselect();
  } else if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
    if (e.key === 'f' && (state.selected || state.selectedShip)) setFollow(!state.follow);
    if (e.key === 'w') showWorld();
  }
});

// ---------------------------------------------------------------------------
// Status bar, legend, toast
// ---------------------------------------------------------------------------

function updateStatus() {
  const dot = $('#live-dot');
  const text = $('#status-text');
  const age = state.lastOk ? Date.now() - state.lastOk : Infinity;
  if (!state.lastOk && state.lastError) {
    dot.className = 'live-dot err';
    text.innerHTML = `No data: ${F.escapeHtml(state.lastError)}`;
    return;
  }
  if (!state.lastOk) return;
  const stale = age > 45000 || state.lastError;
  dot.className = `live-dot ${stale ? 'err' : state.notices.length ? 'warn' : 'ok'}`;
  const src = state.mode === 'demo' ? 'Demo data' : state.sources.join(' + ');
  const ships = state.settings.ships && state.shipVisibleCount ? ` · <b>${F.fmtNumber(state.shipVisibleCount)}</b> ships` : '';
  text.innerHTML = `<b>${F.fmtNumber(state.visibleCount)}</b> aircraft${ships} · ${F.escapeHtml(src)} · ${F.fmtAge(age)}`;
  text.parentElement.title = [...state.notices, ...state.shipNotices].join('\n') || (state.lastError ? `Last update failed: ${state.lastError}` : 'Live');
}

function renderLegend() {
  const maxFt = 44000;
  const stops = F.ALTITUDE_STOPS.map(([ft, c]) => `${c} ${(ft / maxFt) * 100}%`).join(',');
  $('#legend-bar').style.background = `linear-gradient(90deg, ${stops})`;
  const metric = F.UNIT_SYSTEMS[F.getUnits()].alt === 'm';
  const marks = metric ? [0, 3000, 6000, 9000, 12000].map((m) => [m / 0.3048, m ? `${m / 1000} km` : '0 m']) : [0, 10000, 20000, 30000, 40000].map((ft) => [ft, ft ? `${ft / 1000}k ft` : '0 ft']);
  $('#legend-labels').innerHTML = marks.map(([ft, label]) => `<span style="left:${Math.min(100, (ft / maxFt) * 100)}%">${label}</span>`).join('');
}
renderLegend();

let toastTimer = null;
function toast(message, isError = false, action = null) {
  const el = $('#toast');
  el.textContent = message;
  if (action) {
    const btn = document.createElement('button');
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.onclick = () => {
      el.hidden = true;
      action.run();
    };
    el.append(btn);
  }
  el.className = `toast${isError ? ' error' : ''}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, action ? 12000 : 4500);
}

// Android app: diagnostics report, ad privacy options, crash follow-up.
if (NATIVE && window.NativeApp) {
  $('#app-section').hidden = false;
  $('#app-version').textContent = `Version ${window.NativeApp.version()}`;
  $('#btn-report').addEventListener('click', () => window.NativeApp.shareDiagnostics());
  $('#btn-privacy').addEventListener('click', () => window.NativeApp.showPrivacyOptions());
  document.querySelector('[data-panel="settings"]').addEventListener('click', () => {
    $('#btn-privacy').hidden = !window.NativeApp.isPrivacyOptionsRequired();
  });
  window.flightTracker.onPreviousCrash = () => toast('AirSea Radar closed unexpectedly last time.', true, {
    label: 'Send report',
    run: () => window.NativeApp.shareDiagnostics(),
  });
}

// ---------------------------------------------------------------------------
// Start: deep links (?flight=BA117 or ?hex=4ca123) and the first poll
// ---------------------------------------------------------------------------

async function openDeepLink() {
  const params = new URLSearchParams(location.search);
  const hex = params.get('hex');
  const flight = params.get('flight');
  const shipId = params.get('ship');
  try {
    if (shipId) {
      const d = await api(`/api/ship/${encodeURIComponent(shipId)}`);
      if (d.ship) return pickShip(d.ship);
      toast(`Ship ${shipId} is not being tracked right now.`, true);
    } else if (hex) {
      const d = await api(`/api/aircraft/${encodeURIComponent(hex)}`);
      if (d.aircraft) return pickResult(enrich(d.aircraft));
      toast(`Aircraft ${hex.toUpperCase()} is not being tracked right now.`, true);
    } else if (flight) {
      searchInput.value = flight;
      const d = await api(`/api/search?q=${encodeURIComponent(flight)}`);
      const list = (d.aircraft || []).map((ac) => enrich(ac));
      const wanted = callsignCandidates(flight);
      const best = list.find((ac) => wanted.includes(ac.c.toUpperCase())) || list[0];
      if (best) return pickResult(best);
      toast(`Flight ${flight.toUpperCase()} is not airborne or not in coverage right now.`, true);
    }
  } catch (err) {
    toast(`Could not open the shared flight: ${err.message}`, true);
  }
}

// ---------------------------------------------------------------------------
// Loading screen: shown until the map and the first live data are in (or a timeout).
// ---------------------------------------------------------------------------

const Splash = {
  el: $('#splash'),
  steps: { map: 'pending', flights: 'pending', ships: 'pending' },
  started: Date.now(),
  step(name, status, text) {
    if (!this.el || !this.steps[name] || this.steps[name] === status) return;
    this.steps[name] = status;
    const row = this.el.querySelector(`[data-step="${name}"]`);
    if (row) {
      row.dataset.status = status;
      if (text) row.querySelector('.splash-note').textContent = text;
    }
    const done = Object.values(this.steps).filter((v) => v !== 'pending').length;
    this.el.querySelector('.splash-bar i').style.width = `${15 + (done / 3) * 85}%`;
    if (this.steps.map !== 'pending' && this.steps.flights !== 'pending' && (this.steps.ships !== 'pending' || Date.now() - this.started > 6000)) this.hide();
  },
  hide() {
    if (!this.el || this.el.classList.contains('done')) return;
    // Keep it up for a moment so it doesn't flash.
    const wait = Math.max(0, 900 - (Date.now() - this.started));
    setTimeout(() => {
      this.el.classList.add('done');
      document.body.classList.remove('loading');
      setTimeout(() => this.el.remove(), 600);
    }, wait);
  },
};
if (!navigator.onLine) Splash.el?.querySelector('.splash-offline')?.removeAttribute('hidden');
setTimeout(() => Splash.hide(), 15000); // never trap the user behind the loading screen
window.addEventListener('offline', () => toast('You are offline – the built-in map still works; live traffic resumes when you reconnect.', true));
window.addEventListener('online', () => {
  toast('Back online – refreshing live traffic.');
  poll();
  pollShips();
});

// Start as soon as the map style is ready (the 'load' event also waits for every visible tile).
map.once('style.load', () => {
  Splash.step('map', 'ok', state.settings.style === 'builtin' ? 'Built-in offline map' : 'Ready');
  poll();
  pollShips();
  openDeepLink();
  Extras.startClockedOverlays(map, state.settings, (time, err) => weatherStatus(time, err));
});
loadAirports();
