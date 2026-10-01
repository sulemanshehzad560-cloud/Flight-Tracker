// Units, formatting, altitude colours and small geo helpers used across the UI.

export const ALTITUDE_STOPS = [
  // [feet, colour] – the same stops drive the map icons, trails and the legend.
  [0, '#ff5a36'], [1000, '#ff8a1f'], [4000, '#ffc21a'], [8000, '#d4e21b'], [14000, '#6fd64b'],
  [20000, '#1fd1a4'], [26000, '#1fb7e8'], [32000, '#4b8cff'], [38000, '#9a6bff'], [44000, '#e15cf0'],
];
export const GROUND_COLOR = '#8a8f98';
export const EMERGENCY_COLOR = '#ff2d55';
export const EMERGENCY_SQUAWKS = { 7500: 'Hijack', 7600: 'Radio failure', 7700: 'Emergency' };

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function altitudeColor(ft, onGround = false) {
  if (onGround) return GROUND_COLOR;
  if (ft === null || ft === undefined) return '#c7ccd6';
  if (ft <= ALTITUDE_STOPS[0][0]) return ALTITUDE_STOPS[0][1];
  for (let i = 1; i < ALTITUDE_STOPS.length; i++) {
    const [a1, c1] = ALTITUDE_STOPS[i - 1];
    const [a2, c2] = ALTITUDE_STOPS[i];
    if (ft <= a2) {
      const f = (ft - a1) / (a2 - a1);
      const [r1, g1, b1] = hexToRgb(c1);
      const [r2, g2, b2] = hexToRgb(c2);
      const mix = (x, y) => Math.round(x + (y - x) * f);
      return `rgb(${mix(r1, r2)},${mix(g1, g2)},${mix(b1, b2)})`;
    }
  }
  return ALTITUDE_STOPS[ALTITUDE_STOPS.length - 1][1];
}

/** MapLibre expression equivalent of altitudeColor() on feature property `alt` (-1 = ground). */
export function altitudeColorExpression() {
  const stops = ALTITUDE_STOPS.flat();
  return [
    'case',
    ['==', ['get', 'em'], 1], EMERGENCY_COLOR,
    ['<', ['get', 'alt'], 0], GROUND_COLOR,
    ['interpolate', ['linear'], ['get', 'alt'], ...stops],
  ];
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

export const UNIT_SYSTEMS = {
  aviation: { label: 'Aviation (ft, kt)', alt: 'ft', speed: 'kt', dist: 'nm', vs: 'ft/min' },
  metric: { label: 'Metric (m, km/h)', alt: 'm', speed: 'km/h', dist: 'km', vs: 'm/s' },
  imperial: { label: 'Imperial (ft, mph)', alt: 'ft', speed: 'mph', dist: 'mi', vs: 'ft/min' },
};

let units = 'aviation';
export const setUnits = (u) => { units = UNIT_SYSTEMS[u] ? u : 'aviation'; };
export const getUnits = () => units;

const nf0 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

export function fmtAltitude(ft, onGround) {
  if (onGround) return 'On ground';
  if (ft === null || ft === undefined) return '—';
  return UNIT_SYSTEMS[units].alt === 'm' ? `${nf0.format(ft * 0.3048)} m` : `${nf0.format(ft)} ft`;
}

/** Secondary altitude line: the other unit plus a flight level when high enough. */
export function fmtAltitudeAlt(ft, onGround) {
  if (onGround || ft === null || ft === undefined) return '';
  const other = UNIT_SYSTEMS[units].alt === 'm' ? `${nf0.format(ft)} ft` : `${nf0.format(ft * 0.3048)} m`;
  return ft >= 5000 ? `FL${String(Math.round(ft / 100)).padStart(3, '0')} · ${other}` : other;
}

export function fmtSpeed(kt) {
  if (kt === null || kt === undefined) return '—';
  const u = UNIT_SYSTEMS[units].speed;
  if (u === 'km/h') return `${nf0.format(kt * 1.852)} km/h`;
  if (u === 'mph') return `${nf0.format(kt * 1.15078)} mph`;
  return `${nf0.format(kt)} kt`;
}

export function fmtSpeedAlt(kt) {
  if (kt === null || kt === undefined) return '';
  return UNIT_SYSTEMS[units].speed === 'kt' ? `${nf0.format(kt * 1.852)} km/h` : `${nf0.format(kt)} kt`;
}

export function fmtVerticalRate(fpm) {
  if (fpm === null || fpm === undefined) return '—';
  const sign = fpm > 0 ? '+' : '';
  if (UNIT_SYSTEMS[units].vs === 'm/s') return `${sign}${nf1.format(fpm * 0.00508)} m/s`;
  return `${sign}${nf0.format(fpm)} ft/min`;
}

export function fmtDistance(nm) {
  if (nm === null || nm === undefined || !Number.isFinite(nm)) return '—';
  const u = UNIT_SYSTEMS[units].dist;
  if (u === 'km') return `${nf0.format(nm * 1.852)} km`;
  if (u === 'mi') return `${nf0.format(nm * 1.15078)} mi`;
  return `${nf0.format(nm)} nm`;
}

export function fmtHeading(deg) {
  if (deg === null || deg === undefined) return '—';
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return `${Math.round(deg)}° ${dirs[Math.round(deg / 45) % 8]}`;
}

export function fmtCoord(lat, lon) {
  const f = (v, pos, neg) => `${Math.abs(v).toFixed(4)}°${v >= 0 ? pos : neg}`;
  return `${f(lat, 'N', 'S')} ${f(lon, 'E', 'W')}`;
}

export function fmtAge(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s ago`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
}

export function fmtDuration(hours) {
  if (!Number.isFinite(hours) || hours < 0) return '—';
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m} min`;
}

export function fmtNumber(n) {
  return nf0.format(n);
}

export const CATEGORY_LABELS = {
  A1: 'Light aircraft', A2: 'Small aircraft', A3: 'Large aircraft', A4: 'High-vortex large (B757)',
  A5: 'Heavy aircraft', A6: 'High performance', A7: 'Helicopter', B1: 'Glider', B2: 'Balloon / airship',
  B3: 'Parachutist', B4: 'Ultralight', B6: 'Drone (UAV)', B7: 'Space vehicle', C1: 'Emergency vehicle',
  C2: 'Service vehicle', C3: 'Obstacle',
};

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------------------
// Geo
// ---------------------------------------------------------------------------

const toRad = Math.PI / 180;

export function distanceNm(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * 3440.065 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Move a point `distNm` along `bearingDeg` (dead reckoning). */
export function project(lat, lon, bearingDeg, distNm) {
  const d = distNm / 3440.065;
  const b = bearingDeg * toRad;
  const la1 = lat * toRad;
  const lo1 = lon * toRad;
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(b));
  const lo2 = lo1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return [la2 / toRad, ((lo2 / toRad + 540) % 360) - 180];
}

/** Points along the great circle between two coordinates, as [lon, lat] pairs for GeoJSON. */
export function greatCircle(lat1, lon1, lat2, lon2, segments = 64) {
  const [p1, l1, p2, l2] = [lat1 * toRad, lon1 * toRad, lat2 * toRad, lon2 * toRad];
  const d = distanceNm(lat1, lon1, lat2, lon2) / 3440.065;
  if (d < 1e-6) return [[lon1, lat1], [lon2, lat2]];
  const pts = [];
  let prevLon = null;
  for (let i = 0; i <= segments; i++) {
    const f = i / segments;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
    const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
    const z = A * Math.sin(p1) + B * Math.sin(p2);
    let lon = Math.atan2(y, x) / toRad;
    // Keep the line continuous across the antimeridian (MapLibre handles lon > 180).
    if (prevLon !== null) {
      while (lon - prevLon > 180) lon -= 360;
      while (lon - prevLon < -180) lon += 360;
    }
    prevLon = lon;
    pts.push([lon, Math.atan2(z, Math.hypot(x, y)) / toRad]);
  }
  return pts;
}
