// Upstream data sources. All of them are free, community-run services; none of them allow
// browser (CORS) requests, which is why the app talks to them through this server.
//
//  * OpenSky Network  – the only free source with a single "whole world" snapshot.
//                        Anonymous: 400 credits/day (a global request costs 4).
//                        With a free account (OAuth client): 4000+ credits/day.
//  * adsb.lol, airplanes.live, adsb.fi
//                      – unfiltered ADS-B/MLAT feeds (readsb format) with registration,
//                        aircraft type, military flag; queried by point + radius (<= 250 nm)
//                        and by callsign / registration / hex for worldwide search.
//  * adsbdb.com        – origin / destination for a callsign, aircraft details and photos.
//  * adsb.lol routeset – second opinion for routes.
//  * planespotters.net – aircraft photos by hex code.

import { TtlCache } from './cache.js';
import { fromOpenSky, fromReadsb, inBox } from './normalize.js';

const USER_AGENT = 'FlightTracker/1.0 (+https://github.com/sulemanshehzad560-cloud/Flight-Tracker)';
const cache = new TtlCache({ maxEntries: 5000 });

// The HTTP client. Node's fetch by default; the Android app swaps in a native bridge
// (WebView fetch would be blocked by CORS).
let httpFetch = (...args) => fetch(...args);
export function setFetch(fn) {
  httpFetch = fn;
}

export class HttpError extends Error {
  constructor(status, url, retryAfterSec) {
    super(`HTTP ${status} from ${new URL(url).host}`);
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}

export async function fetchJson(url, { timeoutMs = 12000, headers = {}, method = 'GET', body } = {}) {
  const res = await httpFetch(url, {
    method,
    body,
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const retry = Number(res.headers.get('x-rate-limit-retry-after-seconds') || res.headers.get('retry-after'));
    throw new HttpError(res.status, url, Number.isFinite(retry) ? retry : undefined);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ---------------------------------------------------------------------------
// Readsb-style community feeds (point / callsign / registration / hex queries)
// ---------------------------------------------------------------------------

const READSB_FEEDS = [
  {
    id: 'adsb.lol',
    point: (lat, lon, r) => `https://api.adsb.lol/v2/point/${lat}/${lon}/${r}`,
    callsign: (c) => `https://api.adsb.lol/v2/callsign/${c}`,
    reg: (r) => `https://api.adsb.lol/v2/reg/${r}`,
    hex: (h) => `https://api.adsb.lol/v2/hex/${h}`,
  },
  {
    id: 'airplanes.live',
    point: (lat, lon, r) => `https://api.airplanes.live/v2/point/${lat}/${lon}/${r}`,
    callsign: (c) => `https://api.airplanes.live/v2/callsign/${c}`,
    reg: (r) => `https://api.airplanes.live/v2/reg/${r}`,
    hex: (h) => `https://api.airplanes.live/v2/hex/${h}`,
  },
  {
    id: 'adsb.fi',
    point: (lat, lon, r) => `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${r}`,
    callsign: (c) => `https://opendata.adsb.fi/api/v2/callsign/${c}`,
    reg: (r) => `https://opendata.adsb.fi/api/v2/registration/${r}`,
    hex: (h) => `https://opendata.adsb.fi/api/v2/hex/${h}`,
  },
];

// Feeds that recently failed are skipped until their cool-down expires.
const feedCooldown = new Map();

function feedAvailable(feed) {
  return (feedCooldown.get(feed.id) || 0) < Date.now();
}

function penalize(feed, err) {
  const sec = err?.retryAfterSec || (err?.status === 429 ? 30 : 15);
  feedCooldown.set(feed.id, Date.now() + sec * 1000);
}

/** Tries each community feed in turn until one answers. */
async function queryReadsb(kind, ...args) {
  let lastError;
  for (const feed of READSB_FEEDS) {
    if (!feedAvailable(feed)) continue;
    try {
      const data = await fetchJson(feed[kind](...args), { timeoutMs: 8000 });
      const now = data?.now ?? Date.now();
      const list = data?.ac ?? data?.aircraft ?? [];
      return {
        source: feed.id,
        aircraft: list.map((ac) => fromReadsb(ac, now, feed.id)).filter(Boolean),
      };
    } catch (err) {
      lastError = err;
      penalize(feed, err);
    }
  }
  throw lastError || new Error('All community ADS-B feeds are cooling down, try again shortly');
}

/** Every aircraft within `radiusNm` (max 250) of a point. Cached briefly per rounded location. */
export function aircraftNear(lat, lon, radiusNm) {
  const r = Math.max(1, Math.min(250, Math.ceil(radiusNm)));
  const la = lat.toFixed(2);
  const lo = lon.toFixed(2);
  return cache.wrap(`point:${la}:${lo}:${r}`, 2500, () => queryReadsb('point', la, lo, r));
}

export function aircraftByCallsign(callsign) {
  const c = encodeURIComponent(callsign.toUpperCase());
  return cache.wrap(`cs:${c}`, 4000, () => queryReadsb('callsign', c));
}

export function aircraftByRegistration(reg) {
  const r = encodeURIComponent(reg.toUpperCase());
  return cache.wrap(`reg:${r}`, 4000, () => queryReadsb('reg', r));
}

export function aircraftByHex(hex) {
  const h = encodeURIComponent(hex.toLowerCase());
  return cache.wrap(`hex:${h}`, 3000, () => queryReadsb('hex', h));
}

// ---------------------------------------------------------------------------
// OpenSky Network: global snapshot shared by every connected browser
// ---------------------------------------------------------------------------

const OPENSKY_API = 'https://opensky-network.org/api';
const OPENSKY_TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';

export class OpenSkyGlobal {
  constructor({ clientId, clientSecret, ttlSec } = {}) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.authenticated = Boolean(clientId && clientSecret);
    // Anonymous users get ~100 global snapshots per day, so refresh far less often.
    this.ttlMs = (ttlSec || (this.authenticated ? 60 : 300)) * 1000;
    this.snapshot = null; // { time, fetchedAt, aircraft }
    this.pending = null;
    this.blockedUntil = 0;
    this.lastError = null;
    this.creditsRemaining = null;
    this.token = null;
  }

  async authHeaders() {
    if (!this.authenticated) return {};
    if (!this.token || this.token.expires < Date.now() + 30000) {
      const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.clientId,
        client_secret: this.clientSecret,
      });
      const data = await fetchJson(OPENSKY_TOKEN_URL, {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      this.token = { value: data.access_token, expires: Date.now() + (data.expires_in || 1800) * 1000 };
    }
    return { Authorization: `Bearer ${this.token.value}` };
  }

  isFresh() {
    return this.snapshot && Date.now() - this.snapshot.fetchedAt < this.ttlMs;
  }

  /** Returns the latest snapshot, refreshing it when stale (never more than one request at a time). */
  async get() {
    if (this.isFresh() || Date.now() < this.blockedUntil) return this.snapshot;
    if (!this.pending) {
      this.pending = this.refresh().finally(() => {
        this.pending = null;
      });
    }
    // With an old snapshot available, answer immediately and let the refresh finish in the background.
    if (this.snapshot) {
      this.pending.catch(() => {});
      return this.snapshot;
    }
    return this.pending;
  }

  async refresh() {
    try {
      const headers = await this.authHeaders();
      const res = await httpFetch(`${OPENSKY_API}/states/all?extended=1`, {
        headers: { 'User-Agent': USER_AGENT, ...headers },
        signal: AbortSignal.timeout(30000),
      });
      const remaining = res.headers.get('x-rate-limit-remaining');
      if (remaining !== null) this.creditsRemaining = Number(remaining);
      if (!res.ok) {
        const retry = Number(res.headers.get('x-rate-limit-retry-after-seconds'));
        throw new HttpError(res.status, res.url, Number.isFinite(retry) ? retry : undefined);
      }
      const data = await res.json();
      const aircraft = (data.states || []).map((sv) => fromOpenSky(sv, data.time)).filter(Boolean);
      this.snapshot = { time: data.time * 1000, fetchedAt: Date.now(), aircraft };
      this.lastError = null;
      return this.snapshot;
    } catch (err) {
      this.lastError = err.message;
      // Back off: honour the server's hint, otherwise wait a minute (rate limit: an hour).
      const waitSec = err.retryAfterSec || (err.status === 429 ? 3600 : 60);
      this.blockedUntil = Date.now() + Math.min(waitSec, 6 * 3600) * 1000;
      if (this.snapshot) return this.snapshot;
      throw err;
    }
  }

  /** Aircraft from the current snapshot inside a bounding box. */
  async inBox(box) {
    const snap = await this.get();
    if (!snap) return null;
    return { time: snap.time, aircraft: snap.aircraft.filter((ac) => inBox(ac, box)) };
  }

  findCached(predicate) {
    return this.snapshot ? this.snapshot.aircraft.filter(predicate) : [];
  }

  status() {
    return {
      authenticated: this.authenticated,
      snapshotAgeSec: this.snapshot ? Math.round((Date.now() - this.snapshot.fetchedAt) / 1000) : null,
      aircraft: this.snapshot ? this.snapshot.aircraft.length : 0,
      refreshEverySec: this.ttlMs / 1000,
      creditsRemaining: this.creditsRemaining,
      blockedForSec: Math.max(0, Math.round((this.blockedUntil - Date.now()) / 1000)),
      lastError: this.lastError,
    };
  }

  /** Flight path of one aircraft (last flight) – used to draw the full trail. */
  async track(hex) {
    return cache.wrap(`track:${hex}`, 60000, async () => {
      const headers = await this.authHeaders();
      const data = await fetchJson(`${OPENSKY_API}/tracks/all?icao24=${encodeURIComponent(hex)}&time=0`, { headers });
      return (data?.path || []).map(([t, lat, lon, alt, track, onGround]) => ({
        ts: t * 1000,
        la: lat,
        lo: lon,
        a: onGround ? 0 : alt === null ? null : Math.round(alt * 3.28084),
        k: track,
      }));
    });
  }
}

// ---------------------------------------------------------------------------
// Routes, aircraft details and photos
// ---------------------------------------------------------------------------

function airportFromAdsbdb(a) {
  if (!a) return null;
  return {
    iata: a.iata_code || '',
    icao: a.icao_code || '',
    name: a.name || '',
    city: a.municipality || '',
    country: a.country_name || '',
    countryCode: a.country_iso_name || '',
    lat: a.latitude,
    lon: a.longitude,
  };
}

function airportFromAdsbLol(a) {
  if (!a) return null;
  return {
    iata: a.iata || '',
    icao: a.icao || '',
    name: a.name || '',
    city: a.location || '',
    country: '',
    countryCode: a.countryiso2 || '',
    lat: a.lat,
    lon: a.lon,
  };
}

/** Origin / destination for a callsign. Returns null when nobody knows. */
export function routeForCallsign(callsign, lat, lon) {
  const cs = callsign.toUpperCase();
  return cache.wrap(`route:${cs}`, (v) => (v ? 3600000 : 600000), async () => {
    try {
      const data = await fetchJson(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(cs)}`);
      const fr = data?.response?.flightroute;
      if (fr?.origin && fr?.destination) {
        return {
          source: 'adsbdb',
          callsign: fr.callsign || cs,
          flightNumber: fr.callsign_iata || '',
          airline: fr.airline ? { name: fr.airline.name, iata: fr.airline.iata, icao: fr.airline.icao, country: fr.airline.country } : null,
          origin: airportFromAdsbdb(fr.origin),
          destination: airportFromAdsbdb(fr.destination),
          stops: fr.midpoint ? [airportFromAdsbdb(fr.midpoint)] : [],
        };
      }
    } catch {
      // adsbdb answers 404 for unknown callsigns – fall through to adsb.lol.
    }
    try {
      const body = JSON.stringify({ planes: [{ callsign: cs, lat: lat ?? 0, lng: lon ?? 0 }] });
      const data = await fetchJson('https://api.adsb.lol/api/0/routeset', {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/json' },
      });
      const r = Array.isArray(data) ? data[0] : null;
      const airports = r?._airports || [];
      if (airports.length >= 2) {
        return {
          source: 'adsb.lol',
          callsign: r.callsign || cs,
          flightNumber: r.airline_code && r.number ? `${r.airline_code}${r.number}` : '',
          airline: null,
          origin: airportFromAdsbLol(airports[0]),
          destination: airportFromAdsbLol(airports[airports.length - 1]),
          stops: airports.slice(1, -1).map(airportFromAdsbLol),
          plausible: r.plausible,
        };
      }
    } catch {
      // ignore – no route is a normal answer
    }
    return null;
  });
}

/** Registration, type, owner and a photo for an aircraft hex code. */
export function aircraftDetails(hex) {
  const h = hex.toLowerCase();
  return cache.wrap(`details:${h}`, 6 * 3600000, async () => {
    const [db, photo] = await Promise.allSettled([
      fetchJson(`https://api.adsbdb.com/v0/aircraft/${encodeURIComponent(h)}`),
      fetchJson(`https://api.planespotters.net/pub/photos/hex/${encodeURIComponent(h)}`),
    ]);
    const a = db.status === 'fulfilled' ? db.value?.response?.aircraft : null;
    const p = photo.status === 'fulfilled' ? photo.value?.photos?.[0] : null;
    return {
      hex: h,
      registration: a?.registration || '',
      type: a?.type || '',
      icaoType: a?.icao_type || '',
      manufacturer: a?.manufacturer || '',
      owner: a?.registered_owner || '',
      ownerCountry: a?.registered_owner_country_name || '',
      ownerFlag: a?.registered_owner_country_iso_name || '',
      operatorCode: a?.registered_owner_operator_flag_code || '',
      photo: p
        ? { url: p.thumbnail_large?.src || p.thumbnail?.src, link: p.link, credit: p.photographer, source: 'planespotters.net' }
        : a?.url_photo
          ? { url: a.url_photo_thumbnail || a.url_photo, link: a.url_photo, credit: '', source: 'airport-data.com' }
          : null,
    };
  });
}
