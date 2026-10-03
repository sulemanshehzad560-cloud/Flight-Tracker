// Map extras: day/night shading, weather radar (RainViewer), the bundled map's airport layers,
// and the live statistics panel.

const RAINVIEWER_API = 'https://api.rainviewer.com/public/weather-maps.json';
const RAD = Math.PI / 180;

// Weather overlay: 'radar' (rain / snow), 'clouds' (infrared satellite) or 'off'.
let weatherTiles = null; // current RainViewer tile URL template for the selected mode
let weatherTime = null; // time of the frame shown
let overlaySettings = null;

// ---------------------------------------------------------------------------
// Sun position and the day/night terminator
// ---------------------------------------------------------------------------

/** Subsolar point { lat, lon } (degrees) – accurate to a fraction of a degree, plenty for a map. */
export function sunPosition(date = new Date()) {
  const d = date.getTime() / 86400000 - 10957.5; // days since J2000.0
  const g = (357.529 + 0.98560028 * d) * RAD;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const e = (23.439 - 0.00000036 * d) * RAD;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)) / RAD; // degrees
  const decl = Math.asin(Math.sin(e) * Math.sin(L)) / RAD;
  const gmst = ((18.697374558 + 24.06570982441908 * d) % 24) * 15; // degrees
  let lon = ra - gmst;
  lon = ((((lon + 180) % 360) + 360) % 360) - 180;
  return { lat: decl, lon };
}

/** Polygon covering the night side of the Earth. */
export function nightPolygon(date = new Date()) {
  const sun = sunPosition(date);
  const decl = Math.abs(sun.lat) < 0.01 ? 0.01 : sun.lat;
  const ring = [];
  for (let lon = -180; lon <= 180; lon += 2) {
    const lat = Math.atan(-Math.cos((lon - sun.lon) * RAD) / Math.tan(decl * RAD)) / RAD;
    ring.push([lon, lat]);
  }
  const pole = decl > 0 ? -90 : 90; // the pole facing away from the sun
  ring.push([180, pole], [-180, pole], ring[0]);
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } };
}

export function isDaylight(lat, lon, date = new Date()) {
  const sun = sunPosition(date);
  const h = (lon - sun.lon) * RAD;
  const elevation = Math.asin(Math.sin(lat * RAD) * Math.sin(sun.lat * RAD) + Math.cos(lat * RAD) * Math.cos(sun.lat * RAD) * Math.cos(h)) / RAD;
  return elevation > -0.833;
}

/** Approximate local (solar) time at a longitude. */
export function solarTimeText(lon, date = new Date()) {
  const minutes = (((date.getUTCHours() * 60 + date.getUTCMinutes() + Math.round(lon * 4)) % 1440) + 1440) % 1440;
  return `≈ ${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')} (solar time)`;
}

// ---------------------------------------------------------------------------
// Overlay layers (re-added after every map style change)
// ---------------------------------------------------------------------------

export function addOverlays(map, settings) {
  overlaySettings = settings;
  if (!map.getSource('daynight')) map.addSource('daynight', { type: 'geojson', data: nightPolygon() });
  map.addLayer({
    id: 'daynight', type: 'fill', source: 'daynight',
    layout: { visibility: settings.daynight ? 'visible' : 'none' },
    paint: { 'fill-color': '#000000', 'fill-opacity': 0.42, 'fill-antialias': false },
  });
  if (weatherTiles && settings.weatherMode !== 'off') addWeatherLayer(map);
  setBaseAirports(map, settings.airports);
}

function addWeatherLayer(map) {
  if (map.getLayer('weather')) map.removeLayer('weather');
  if (map.getSource('weather')) map.removeSource('weather');
  const clouds = overlaySettings?.weatherMode === 'clouds';
  map.addSource('weather', {
    type: 'raster', tiles: [weatherTiles], tileSize: 256, maxzoom: 7,
    attribution: clouds ? 'Satellite © RainViewer' : 'Weather radar © RainViewer',
  });
  map.addLayer({
    id: 'weather', type: 'raster', source: 'weather',
    paint: { 'raster-opacity': overlaySettings?.weatherOpacity ?? 0.65, 'raster-fade-duration': 0 },
  }, map.getLayer('daynight') ? 'daynight' : undefined);
}

export function setDayNight(map, on) {
  if (map.getLayer('daynight')) map.setLayoutProperty('daynight', 'visibility', on ? 'visible' : 'none');
  if (on) map.getSource('daynight')?.setData(nightPolygon());
}

/** Latest RainViewer frame for a mode; returns the tile URL template and the frame time. */
async function latestFrame(mode) {
  const res = await fetch(RAINVIEWER_API);
  if (!res.ok) throw new Error(`RainViewer answered ${res.status}`);
  const data = await res.json();
  const frames = (mode === 'clouds' ? data.satellite?.infrared : data.radar?.past) || [];
  const latest = frames[frames.length - 1];
  if (!latest) throw new Error(mode === 'clouds' ? 'no satellite images available right now' : 'no radar images available right now');
  // Radar: colour scheme 2, smoothed, with snow. Clouds: the infrared satellite scheme.
  const suffix = mode === 'clouds' ? '0/0_0.png' : '2/1_1.png';
  return { tiles: `${data.host}${latest.path}/256/{z}/{x}/{y}/${suffix}`, time: new Date(latest.time * 1000) };
}

/** Switch the weather overlay: mode 'radar' | 'clouds' | 'off'. Resolves to the frame time (or null). */
export async function setWeather(map, mode) {
  if (mode === 'off') {
    if (map.getLayer('weather')) map.removeLayer('weather');
    if (map.getSource('weather')) map.removeSource('weather');
    weatherTiles = null;
    weatherTime = null;
    return null;
  }
  const frame = await latestFrame(mode);
  if (overlaySettings?.weatherMode !== mode) return null; // the user switched again meanwhile
  weatherTiles = frame.tiles;
  weatherTime = frame.time;
  addWeatherLayer(map);
  return weatherTime;
}

export function setWeatherOpacity(map, opacity) {
  if (map.getLayer('weather')) map.setPaintProperty('weather', 'raster-opacity', opacity);
}

export const weatherFrameTime = () => weatherTime;

/** Airport dots and codes of the bundled map. */
export function setBaseAirports(map, on) {
  for (const id of ['airport-dots-large', 'airport-dots-small', 'airport-labels-large', 'airport-labels-small']) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  }
}

/** Keeps the terminator moving and the weather fresh (new radar frames every ~10 minutes). */
export function startClockedOverlays(map, settings, onWeather = () => {}) {
  setInterval(() => {
    if (settings.daynight) map.getSource('daynight')?.setData(nightPolygon());
  }, 60 * 1000);
  const refresh = () => {
    if (settings.weatherMode && settings.weatherMode !== 'off') {
      setWeather(map, settings.weatherMode).then(onWeather, (err) => onWeather(null, err));
    }
  };
  setInterval(refresh, 10 * 60 * 1000);
  refresh();
}

/** Small round marker image for city points. */
export function dotImage(fill, stroke) {
  const size = 12;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = stroke;
  ctx.stroke();
  return ctx.getImageData(0, 0, size, size);
}

// ---------------------------------------------------------------------------
// Live statistics panel
// ---------------------------------------------------------------------------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = new Intl.NumberFormat();

function bars(rows, total) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return `<div class="st-bars">${rows.map((r) => `
    <${r.action ? `button data-action="${esc(r.action)}"` : 'div'} class="st-row">
      <span class="st-label">${r.swatch ? `<i style="background:${r.swatch}"></i>` : ''}${esc(r.label)}</span>
      <span class="st-track"><span class="st-fill" style="width:${(r.value / max) * 100}%"></span></span>
      <span class="st-value">${nf.format(r.value)}${total ? `<small>${Math.round((r.value / total) * 100)}%</small>` : ''}</span>
    </${r.action ? 'button' : 'div'}>`).join('')}</div>`;
}

export function renderStats(el, o) {
  if (!el) return;
  const airborne = o.aircraft.filter((a) => !a.g);
  const bands = [[0, 10000], [10000, 20000], [20000, 30000], [30000, 40000], [40000, Infinity]].map(([lo, hi]) => ({
    label: hi === Infinity ? `${lo / 1000}k ft +` : `${lo / 1000}–${hi / 1000}k ft`,
    value: airborne.filter((a) => (a.a ?? 0) >= lo && (a.a ?? 0) < hi).length,
    swatch: o.altitudeColor(hi === Infinity ? 42000 : (lo + hi) / 2, false),
  }));

  const airlines = new Map();
  for (const a of o.aircraft) if (a._airline) {
    const key = a._airline.icao;
    airlines.set(key, { name: a._airline.name, count: (airlines.get(key)?.count || 0) + 1 });
  }
  const topAirlines = [...airlines.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 6)
    .map(([icao, v]) => ({ label: v.name, value: v.count, action: `airline:${icao}` }));

  const highest = airborne.reduce((best, a) => ((a.a ?? 0) > (best?.a ?? -1) ? a : best), null);
  const fastest = airborne.reduce((best, a) => ((a.s ?? 0) > (best?.s ?? -1) ? a : best), null);
  const fastestShip = o.ships.reduce((best, s) => ((s.s ?? 0) > (best?.s ?? -1) ? s : best), null);
  const moving = o.ships.filter((s) => (s.s ?? 0) >= 0.5).length;

  const shipCats = new Map();
  for (const s of o.ships) {
    const c = o.shipCategory(s.t);
    shipCats.set(c, (shipCats.get(c) || 0) + 1);
  }
  const shipRows = [...shipCats.entries()].sort((a, b) => b[1] - a[1])
    .map(([c, n]) => ({ label: o.categories[c].label, value: n, swatch: o.categories[c].color }));

  const record = (title, name, value, action) => (name ? `
    <button class="st-record" data-action="${esc(action)}"><span class="st-record-title">${title}</span><b>${esc(name)}</b><span>${esc(value)}</span></button>` : '');

  el.innerHTML = `
    <div class="st-tiles">
      <div><b>${nf.format(o.aircraft.length)}</b><span>aircraft in view</span></div>
      <div><b>${nf.format(airborne.length)}</b><span>flying</span></div>
      <div><b>${nf.format(o.ships.length)}</b><span>ships · ${nf.format(moving)} moving</span></div>
    </div>
    <h3>Flights by altitude</h3>
    ${bars(bands, airborne.length)}
    ${topAirlines.length ? `<h3>Busiest airlines here <small>tap to filter</small></h3>${bars(topAirlines)}` : ''}
    <h3>Records in view <small>tap to fly there</small></h3>
    <div class="st-records">
      ${record('Highest', highest && (highest.c || highest.h.toUpperCase()), highest && o.fmtAltitude(highest.a, false), highest && `ac:${highest.h}`)}
      ${record('Fastest', fastest && (fastest.c || fastest.h.toUpperCase()), fastest && o.fmtSpeed(fastest.s), fastest && `ac:${fastest.h}`)}
      ${record('Fastest ship', fastestShip && (fastestShip.n || fastestShip.id), fastestShip && `${(fastestShip.s ?? 0).toFixed(1)} kn`, fastestShip && `ship:${fastestShip.id}`)}
    </div>
    ${shipRows.length ? `<h3>Ships by type</h3>${bars(shipRows, o.ships.length)}` : ''}`;

  el.querySelectorAll('[data-action]').forEach((b) => b.addEventListener('click', () => {
    const [kind, id] = b.dataset.action.split(':');
    if (kind === 'ac') o.onAircraft(id);
    if (kind === 'ship') o.onShip(id);
    if (kind === 'airline') o.onAirline(id);
  }));
}
