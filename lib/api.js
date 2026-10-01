// The JSON API (aircraft in a box, search, route, details, track, status), independent of HTTP.
// Used by server.js, and by the Android app, which runs it on the phone itself.

import { boxCircle, mergeAircraft, inBox } from './normalize.js';
import {
  aircraftNear, aircraftByCallsign, aircraftByRegistration, aircraftByHex, routeForCallsign, aircraftDetails,
} from './providers.js';
import { callsignCandidates, airlinePrefixes } from '../public/js/airlines.js';

// A circle up to this radius is served by the detailed regional feeds instead of OpenSky.
const REGIONAL_MAX_NM = 250;

function parseBox(params) {
  const box = {
    lamin: Number(params.get('lamin')), lomin: Number(params.get('lomin')),
    lamax: Number(params.get('lamax')), lomax: Number(params.get('lomax')),
  };
  if (Object.values(box).some((v) => !Number.isFinite(v))) return null;
  box.lamin = Math.max(-90, box.lamin);
  box.lamax = Math.min(90, box.lamax);
  // A view wider than the world: normalise to the whole globe.
  if (box.lomax - box.lomin >= 360) Object.assign(box, { lomin: -180, lomax: 180 });
  const wrap = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;
  box.lomin = box.lomin === -180 ? -180 : wrap(box.lomin);
  box.lomax = box.lomax === 180 ? 180 : wrap(box.lomax);
  return box;
}

function looksLikeHex(q) {
  return /^[0-9a-f]{6}$/i.test(q);
}

function looksLikeRegistration(q) {
  return /^[A-Z0-9]{1,2}-[A-Z0-9]{2,5}$/i.test(q) || /^N\d[0-9A-Z]{0,4}$/i.test(q) || /^[A-Z]{1,2}\d{3,5}$/i.test(q);
}

/**
 * Returns `handle(url) -> Promise<[status, payload]>`.
 * `opensky` is an OpenSkyGlobal; `demo` an optional DemoTraffic that replaces all live sources.
 */
export function createApi({ opensky, demo = null, statusExtra = () => ({}) }) {
  async function apiAircraft(params) {
    const box = parseBox(params);
    if (!box) return [400, { error: 'lamin, lomin, lamax and lomax are required' }];
    if (demo) return [200, { now: Date.now(), mode: 'demo', sources: ['demo'], aircraft: demo.inBox(box) }];

    const circle = boxCircle(box);
    const sources = [];
    const notices = [];
    let regional = [];
    let global = [];

    // Detailed feed around the centre of the view (always – it also refreshes the area people look at).
    const regionalTask = aircraftNear(circle.lat, circle.lon, Math.min(circle.radius, REGIONAL_MAX_NM))
      .then((r) => {
        regional = r.aircraft.filter((ac) => inBox(ac, box));
        sources.push(r.source);
      })
      .catch((err) => notices.push(`Regional feed unavailable (${err.message}).`));

    // World snapshot for views bigger than one regional circle.
    let globalTask = Promise.resolve();
    if (circle.radius > REGIONAL_MAX_NM) {
      globalTask = opensky.inBox(box)
        .then((r) => {
          if (r) {
            global = r.aircraft;
            sources.push('opensky');
          }
        })
        .catch((err) => notices.push(`Worldwide feed unavailable (${err.message}) – showing ${REGIONAL_MAX_NM} nm around the map centre.`));
    }
    await Promise.all([regionalTask, globalTask]);

    if (!sources.length) return [502, { error: notices.join(' ') || 'No data source is reachable right now' }];
    const mode = circle.radius > REGIONAL_MAX_NM ? 'global' : 'regional';
    return [200, { now: Date.now(), mode, sources, notices, aircraft: mergeAircraft(global, regional) }];
  }

  async function apiSearch(params) {
    const raw = String(params.get('q') || '').trim();
    if (!raw) return [400, { error: 'q is required' }];
    const q = raw.toUpperCase().replace(/\s+/g, '');
    const candidates = callsignCandidates(q);
    const qNoDash = q.replace(/-/g, '');

    const localMatch = (ac) =>
      candidates.includes(ac.c.toUpperCase()) ||
      ac.h === q.toLowerCase() ||
      (ac.r && ac.r.toUpperCase().replace(/-/g, '') === qNoDash);

    // Nothing exact: list flights whose callsign starts with the query or airline ("EK", "PIA", "Emirates").
    const prefixes = airlinePrefixes(raw);
    const byPrefix = (ac) => prefixes.some((p) => ac.c.toUpperCase().startsWith(p));

    if (demo) {
      let hits = demo.find(localMatch);
      if (!hits.length) hits = demo.find(byPrefix).slice(0, 50);
      return [200, { query: raw, candidates, aircraft: hits }];
    }

    const lookups = candidates.slice(0, 4).map((c) => aircraftByCallsign(c));
    if (looksLikeHex(q)) lookups.push(aircraftByHex(q));
    if (looksLikeRegistration(q)) lookups.push(aircraftByRegistration(q));

    const settled = await Promise.allSettled(lookups);
    const remote = settled.filter((s) => s.status === 'fulfilled').flatMap((s) => s.value.aircraft);
    let aircraft = mergeAircraft(opensky.findCached(localMatch), remote);

    if (!aircraft.length) aircraft = opensky.findCached(byPrefix).slice(0, 50);
    return [200, { query: raw, candidates, aircraft }];
  }

  async function apiAircraftByHex(hex) {
    if (!looksLikeHex(hex)) return [400, { error: 'Invalid hex code' }];
    const h = hex.toLowerCase();
    if (demo) return [200, { aircraft: demo.find((ac) => ac.h === h)[0] || null }];
    const [remote] = await Promise.allSettled([aircraftByHex(h)]);
    const list = mergeAircraft(
      opensky.findCached((ac) => ac.h === h),
      remote.status === 'fulfilled' ? remote.value.aircraft : [],
    );
    return [200, { aircraft: list[0] || null }];
  }

  async function apiRoute(params) {
    const callsign = String(params.get('callsign') || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{2,8}$/.test(callsign)) return [400, { error: 'Invalid callsign' }];
    if (demo) return [200, { route: demo.route(callsign) }];
    const lat = Number(params.get('lat'));
    const lon = Number(params.get('lon'));
    const route = await routeForCallsign(callsign, Number.isFinite(lat) ? lat : null, Number.isFinite(lon) ? lon : null);
    return [200, { route }];
  }

  async function apiDetails(params) {
    const hex = String(params.get('hex') || '');
    if (!looksLikeHex(hex)) return [400, { error: 'Invalid hex code' }];
    if (demo) return [200, { details: demo.details(hex.toLowerCase()) }];
    return [200, { details: await aircraftDetails(hex) }];
  }

  async function apiTrack(params) {
    const hex = String(params.get('hex') || '');
    if (!looksLikeHex(hex)) return [400, { error: 'Invalid hex code' }];
    if (demo) return [200, { path: demo.track(hex.toLowerCase()) }];
    try {
      return [200, { path: await opensky.track(hex.toLowerCase()) }];
    } catch {
      return [200, { path: [] }]; // tracks are a nice-to-have; the browser draws its own trail too
    }
  }

  function apiStatus() {
    return [200, { demo: Boolean(demo), opensky: opensky.status(), ...statusExtra() }];
  }

  return async function handle(url) {
    const p = url.pathname;
    if (p === '/api/aircraft') return apiAircraft(url.searchParams);
    if (p.startsWith('/api/aircraft/')) return apiAircraftByHex(decodeURIComponent(p.slice('/api/aircraft/'.length)));
    if (p === '/api/search') return apiSearch(url.searchParams);
    if (p === '/api/route') return apiRoute(url.searchParams);
    if (p === '/api/details') return apiDetails(url.searchParams);
    if (p === '/api/track') return apiTrack(url.searchParams);
    if (p === '/api/status') return apiStatus();
    return [404, { error: 'Unknown endpoint' }];
  };
}
