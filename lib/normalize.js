// Converts each provider's aircraft format into one compact shape the browser understands.
//
// Normalized aircraft (short keys keep a 10k-aircraft world snapshot small):
//   h   ICAO 24-bit hex address (lowercase)       c   callsign (trimmed) or ''
//   r   registration or ''                        t   ICAO type designator or ''
//   d   type description or ''                    o   operator / owner or ''
//   co  country of registration or ''             la  latitude          lo  longitude
//   a   barometric altitude ft (null if unknown)  ag  geometric altitude ft (null)
//   g   on ground (bool)                          s   ground speed kt (null)
//   k   track / heading deg (null)                v   vertical rate ft/min (null)
//   q   squawk or ''                              ct  emitter category ("A3", "A7", ...) or ''
//   m   military (bool)                           ts  position timestamp (ms since epoch)
//   src data source id

const M_TO_FT = 3.28084;
const MS_TO_KT = 1.943844;
const MS_TO_FPM = 196.850394;

const OPENSKY_CATEGORY = {
  2: 'A1', 3: 'A2', 4: 'A3', 5: 'A4', 6: 'A5', 7: 'A6', 8: 'A7',
  9: 'B1', 10: 'B2', 11: 'B3', 12: 'B4', 14: 'B6', 15: 'B7',
  16: 'C1', 17: 'C2', 18: 'C3', 19: 'C3', 20: 'C3',
};

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round = (v, digits = 0) => {
  if (v === null) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

/** OpenSky /states/all state vector (array) -> normalized aircraft. */
export function fromOpenSky(sv, responseTimeSec) {
  const lat = num(sv[6]);
  const lon = num(sv[5]);
  if (lat === null || lon === null) return null;
  const onGround = Boolean(sv[8]);
  const baro = num(sv[7]);
  const geo = num(sv[13]);
  const posTime = num(sv[3]) ?? num(sv[4]) ?? responseTimeSec;
  return {
    h: String(sv[0] || '').toLowerCase(),
    c: String(sv[1] || '').trim(),
    r: '', t: '', d: '', o: '',
    co: sv[2] || '',
    la: round(lat, 5),
    lo: round(lon, 5),
    a: onGround ? 0 : round(baro === null ? null : baro * M_TO_FT),
    ag: round(geo === null ? null : geo * M_TO_FT),
    g: onGround,
    s: round(num(sv[9]) === null ? null : sv[9] * MS_TO_KT, 1),
    k: round(num(sv[10]), 1),
    v: round(num(sv[11]) === null ? null : sv[11] * MS_TO_FPM),
    q: sv[14] || '',
    ct: OPENSKY_CATEGORY[sv[17]] || '',
    m: false,
    ts: posTime * 1000,
    src: 'opensky',
  };
}

/** readsb / ADSBExchange-v2 style aircraft (adsb.lol, airplanes.live, adsb.fi) -> normalized. */
export function fromReadsb(ac, nowMs, src) {
  const lat = num(ac.lat) ?? num(ac.lastPosition?.lat);
  const lon = num(ac.lon) ?? num(ac.lastPosition?.lon);
  if (lat === null || lon === null) return null;
  const onGround = ac.alt_baro === 'ground';
  const seenPos = num(ac.seen_pos) ?? num(ac.lastPosition?.seen_pos) ?? num(ac.seen) ?? 0;
  return {
    h: String(ac.hex || '').replace(/^~/, '').toLowerCase(),
    c: String(ac.flight || '').trim(),
    r: ac.r || '',
    t: ac.t || '',
    d: ac.desc || '',
    o: ac.ownOp || '',
    co: '',
    la: round(lat, 5),
    lo: round(lon, 5),
    a: onGround ? 0 : num(ac.alt_baro),
    ag: num(ac.alt_geom),
    g: onGround,
    s: round(num(ac.gs), 1),
    k: round(num(ac.track) ?? num(ac.true_heading) ?? num(ac.mag_heading), 1),
    v: num(ac.baro_rate) ?? num(ac.geom_rate),
    q: ac.squawk || '',
    ct: ac.category || '',
    m: Boolean((ac.dbFlags || 0) & 1),
    ts: Math.round(nowMs - seenPos * 1000),
    src,
  };
}

/** Merge lists; for duplicate hex codes the most recent position wins, filling gaps from the other. */
export function mergeAircraft(...lists) {
  const byHex = new Map();
  for (const list of lists) {
    for (const ac of list) {
      if (!ac || !ac.h) continue;
      const prev = byHex.get(ac.h);
      if (!prev) {
        byHex.set(ac.h, ac);
        continue;
      }
      const [newer, older] = ac.ts >= prev.ts ? [ac, prev] : [prev, ac];
      const merged = { ...newer };
      for (const key of Object.keys(older)) {
        if (merged[key] === '' || merged[key] === null || merged[key] === undefined) merged[key] = older[key];
      }
      byHex.set(ac.h, merged);
    }
  }
  return [...byHex.values()];
}

/** Bounding box filter that copes with boxes crossing the antimeridian (lomin > lomax). */
export function inBox(ac, box) {
  if (ac.la < box.lamin || ac.la > box.lamax) return false;
  if (box.lomin <= box.lomax) return ac.lo >= box.lomin && ac.lo <= box.lomax;
  return ac.lo >= box.lomin || ac.lo <= box.lomax;
}

/** Great-circle distance in nautical miles. */
export function distanceNm(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * 3440.065 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Centre point and the radius (nm) of a circle that covers the whole box. */
export function boxCircle(box) {
  let lomax = box.lomax;
  if (box.lomin > lomax) lomax += 360;
  const lat = (box.lamin + box.lamax) / 2;
  let lon = (box.lomin + lomax) / 2;
  if (lon > 180) lon -= 360;
  const radius = Math.max(
    distanceNm(lat, lon, box.lamin, box.lomin),
    distanceNm(lat, lon, box.lamax, box.lomin),
    distanceNm(lat, lon, box.lamin, lomax),
    distanceNm(lat, lon, box.lamax, lomax),
  );
  return { lat, lon, radius };
}
