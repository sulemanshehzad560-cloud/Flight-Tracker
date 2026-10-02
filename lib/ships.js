// Live ship positions from AIS (Automatic Identification System), shared by server.js and the Android app.
//
//  * aisstream.io     – worldwide AIS over a WebSocket. Free, but needs an API key, and it refuses browser
//                       connections, so the server (or the Android app natively) holds the connection.
//  * Digitraffic      – Finnish Transport Infrastructure Agency open data: Baltic Sea and surroundings,
//                       no key. Polled over HTTPS.
//
// Normalized ship (short keys, like aircraft):
//   id  MMSI (string)            n   name                 la/lo position
//   s   speed over ground (kn)   c   course over ground   h   true heading (deg)
//   ns  navigational status      t   AIS ship type code   d   destination
//   cs  call sign                imo IMO number           l/w length / beam (m)
//   dr  draught (m)              eta "MM-DD HH:MM" UTC     ts  position time (ms)   src source

import { fetchJson } from './providers.js';
import { inBox } from './normalize.js';

const DIGITRAFFIC = 'https://meri.digitraffic.fi/api/ais/v1';
// (No Accept-Encoding: Node and Android both negotiate gzip themselves and only then decompress.)
const DIGITRAFFIC_HEADERS = { 'Digitraffic-User': 'FlightTracker/1.0' };
// Roughly the area Digitraffic receivers cover (Baltic Sea and approaches).
export const DIGITRAFFIC_AREA = { lamin: 53, lamax: 72, lomin: 8, lomax: 34 };
const DIGITRAFFIC_LOCATIONS_MS = 60 * 1000;
const DIGITRAFFIC_METADATA_MS = 60 * 60 * 1000;

const STALE_MOVING_MS = 30 * 60 * 1000;
const STALE_STATIONARY_MS = 3 * 60 * 60 * 1000;
const MAX_RESULTS = 12000;

const POSITION_TYPES = new Set(['PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport']);

const cleanText = (s) => String(s ?? '').replace(/@+$/g, '').trim();
const orNull = (v, invalid) => (typeof v === 'number' && Number.isFinite(v) && v !== invalid ? v : null);

/** "2024-05-01 12:34:56.123456789 +0000 UTC" -> ms */
export function parseAisTime(text) {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d{1,3})?/.exec(String(text || ''));
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${m[2]}${m[3] || ''}Z`);
  return Number.isFinite(t) ? t : null;
}

function etaText(month, day, hour, minute) {
  if (!month || !day || month > 12 || day > 31) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(month)}-${p(day)} ${hour < 24 ? p(hour) : '--'}:${minute < 60 ? p(minute) : '--'}`;
}

function validPosition(lat, lon) {
  return typeof lat === 'number' && typeof lon === 'number' && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
}

export class ShipTracker {
  /**
   * `openStream` (optional) connects to aisstream: ({ onMessage, onStatus }) -> { subscribe(boxes), close() }.
   * `globalStream` subscribes once to the whole world (server); otherwise the stream follows the viewed area (phone).
   */
  constructor({ openStream = null, globalStream = true } = {}) {
    this.ships = new Map();
    this.openStream = openStream;
    this.globalStream = globalStream;
    this.stream = null;
    this.streamStatus = openStream ? 'connecting' : 'disabled';
    this.streamMessages = 0;
    this.subscribedKey = '';
    this.dt = { lastLocations: 0, lastMetadata: 0, from: 0, metaFrom: 0, pending: null, error: null };
    this.lastPrune = Date.now();
    if (openStream && globalStream) this.startStream([[[-90, -180], [90, 180]]]);
  }

  // ------------------------------------------------------------------ aisstream

  startStream(boxes) {
    this.stream = this.openStream({
      onMessage: (msg) => this.handleAisMessage(msg),
      onStatus: (status) => { this.streamStatus = status; },
    });
    this.stream.subscribe(boxes);
  }

  /** Phone: follow the viewed area (aisstream allows changing the subscription on an open connection). */
  followArea(box) {
    if (!this.openStream || this.globalStream) return;
    // Pad the view so small pans don't need a new subscription; round to keep the key stable.
    const padLat = Math.max(1, (box.lamax - box.lamin) * 0.5);
    const padLon = Math.max(1, (box.lomin <= box.lomax ? box.lomax - box.lomin : 360 - box.lomin + box.lomax) * 0.5);
    const r = (v) => Math.round(v);
    const s = Math.max(-90, r(box.lamin - padLat));
    const n = Math.min(90, r(box.lamax + padLat));
    const boxes = [];
    let w = r(box.lomin - padLon);
    let e = r(box.lomax + padLon);
    if (box.lomin > box.lomax || e - w >= 360) {
      boxes.push([[s, -180], [n, 180]]);
    } else {
      // Split boxes that cross the antimeridian.
      if (w < -180) {
        boxes.push([[s, w + 360], [n, 180]]);
        w = -180;
      }
      if (e > 180) {
        boxes.push([[s, -180], [n, e - 360]]);
        e = 180;
      }
      boxes.push([[s, w], [n, e]]);
    }
    const key = JSON.stringify(boxes);
    if (key === this.subscribedKey) return;
    this.subscribedKey = key;
    if (!this.stream) this.startStream(boxes);
    else this.stream.subscribe(boxes);
  }

  shipFor(id) {
    let ship = this.ships.get(id);
    if (!ship) {
      ship = { id, n: '', la: null, lo: null, s: null, c: null, h: null, ns: null, t: null, d: '', cs: '', imo: null, l: null, w: null, dr: null, eta: '', ts: 0, src: '' };
      this.ships.set(id, ship);
    }
    return ship;
  }

  /** One aisstream message (parsed JSON object or text). */
  handleAisMessage(raw) {
    let msg = raw;
    if (typeof raw === 'string') {
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
    }
    const type = msg?.MessageType;
    const meta = msg?.MetaData || {};
    const body = msg?.Message?.[type];
    if (!type || !body) return;
    const mmsi = meta.MMSI ?? body.UserID;
    if (!mmsi) return;
    this.streamMessages++;
    const ship = this.shipFor(String(mmsi));
    const name = cleanText(meta.ShipName);
    if (name) ship.n = name;

    if (POSITION_TYPES.has(type)) {
      const lat = body.Latitude ?? meta.latitude;
      const lon = body.Longitude ?? meta.longitude;
      const ts = parseAisTime(meta.time_utc) ?? Date.now();
      if (validPosition(lat, lon) && ts >= ship.ts) {
        ship.la = +lat.toFixed(5);
        ship.lo = +lon.toFixed(5);
        ship.s = orNull(body.Sog, 102.3);
        ship.c = orNull(body.Cog, 360);
        ship.h = orNull(body.TrueHeading, 511);
        if (typeof body.NavigationalStatus === 'number') ship.ns = body.NavigationalStatus;
        ship.ts = ts;
        ship.src = 'aisstream';
      }
      if (type === 'ExtendedClassBPositionReport') {
        if (cleanText(body.Name)) ship.n = cleanText(body.Name);
        if (body.Type) ship.t = body.Type;
        this.applyDimension(ship, body.Dimension);
      }
    } else if (type === 'ShipStaticData') {
      if (cleanText(body.Name)) ship.n = cleanText(body.Name);
      if (body.Type) ship.t = body.Type;
      ship.cs = cleanText(body.CallSign) || ship.cs;
      if (body.ImoNumber) ship.imo = body.ImoNumber;
      ship.d = cleanText(body.Destination) || ship.d;
      if (body.MaximumStaticDraught) ship.dr = body.MaximumStaticDraught;
      if (body.Eta) ship.eta = etaText(body.Eta.Month, body.Eta.Day, body.Eta.Hour, body.Eta.Minute) || ship.eta;
      this.applyDimension(ship, body.Dimension);
    } else if (type === 'StaticDataReport') {
      if (cleanText(body.ReportA?.Name)) ship.n = cleanText(body.ReportA.Name);
      if (body.ReportB?.ShipType) ship.t = body.ReportB.ShipType;
      if (cleanText(body.ReportB?.CallSign)) ship.cs = cleanText(body.ReportB.CallSign);
      this.applyDimension(ship, body.ReportB?.Dimension);
    }
  }

  applyDimension(ship, dim) {
    if (!dim) return;
    const l = (dim.A || 0) + (dim.B || 0);
    const w = (dim.C || 0) + (dim.D || 0);
    if (l > 0) ship.l = l;
    if (w > 0) ship.w = w;
  }

  // ------------------------------------------------------------------ Digitraffic

  async refreshDigitraffic() {
    if (this.dt.pending) return this.dt.pending;
    const now = Date.now();
    const needLocations = now - this.dt.lastLocations > DIGITRAFFIC_LOCATIONS_MS;
    const needMetadata = now - this.dt.lastMetadata > DIGITRAFFIC_METADATA_MS;
    if (!needLocations && !needMetadata) return null;
    this.dt.pending = (async () => {
      try {
        if (needLocations) await this.loadDigitrafficLocations();
        if (needMetadata) await this.loadDigitrafficMetadata();
        this.dt.error = null;
      } catch (err) {
        this.dt.error = err.message;
        this.dt.lastLocations = Date.now(); // back off for one interval
      } finally {
        this.dt.pending = null;
      }
    })();
    return this.dt.pending;
  }

  async loadDigitrafficLocations() {
    const qs = this.dt.from ? `?from=${this.dt.from}` : '';
    const data = await fetchJson(`${DIGITRAFFIC}/locations${qs}`, { headers: DIGITRAFFIC_HEADERS, timeoutMs: 30000 });
    for (const f of data?.features || []) {
      const p = f.properties || {};
      const [lon, lat] = f.geometry?.coordinates || [];
      const mmsi = f.mmsi ?? p.mmsi;
      const ts = p.timestampExternal || Date.now();
      if (!mmsi || !validPosition(lat, lon)) continue;
      const ship = this.shipFor(String(mmsi));
      if (ts < ship.ts) continue;
      Object.assign(ship, {
        la: lat, lo: lon, s: orNull(p.sog, 102.3), c: orNull(p.cog, 360), h: orNull(p.heading, 511),
        ns: typeof p.navStat === 'number' ? p.navStat : ship.ns, ts, src: 'digitraffic',
      });
    }
    // Next time only ask for changes (with a little overlap).
    const updated = Date.parse(data?.dataUpdatedTime);
    this.dt.from = (Number.isFinite(updated) ? updated : Date.now()) - 60 * 1000;
    this.dt.lastLocations = Date.now();
  }

  async loadDigitrafficMetadata() {
    const qs = this.dt.metaFrom ? `?from=${this.dt.metaFrom}` : '';
    const list = await fetchJson(`${DIGITRAFFIC}/vessels${qs}`, { headers: DIGITRAFFIC_HEADERS, timeoutMs: 45000 });
    for (const v of Array.isArray(list) ? list : []) {
      if (!v.mmsi) continue;
      const ship = this.shipFor(String(v.mmsi));
      if (cleanText(v.name)) ship.n = cleanText(v.name);
      if (v.shipType) ship.t = v.shipType;
      if (cleanText(v.callSign)) ship.cs = cleanText(v.callSign);
      if (v.imo) ship.imo = v.imo;
      if (cleanText(v.destination)) ship.d = cleanText(v.destination);
      if (v.draught) ship.dr = v.draught / 10;
      if (v.eta) ship.eta = etaText((v.eta >> 16) & 15, (v.eta >> 11) & 31, (v.eta >> 6) & 31, v.eta & 63) || ship.eta;
      this.applyDimension(ship, { A: v.referencePointA, B: v.referencePointB, C: v.referencePointC, D: v.referencePointD });
    }
    this.dt.metaFrom = Date.now() - 5 * 60 * 1000;
    this.dt.lastMetadata = Date.now();
  }

  // ------------------------------------------------------------------ queries

  prune() {
    const now = Date.now();
    if (now - this.lastPrune < 5 * 60 * 1000) return;
    this.lastPrune = now;
    for (const [id, ship] of this.ships) {
      const moving = (ship.s ?? 0) >= 1;
      if (ship.ts && now - ship.ts > (moving ? STALE_MOVING_MS : STALE_STATIONARY_MS)) this.ships.delete(id);
    }
  }

  /** Ships inside a box (moving ships first when there are too many). */
  async inBox(box) {
    this.prune();
    this.followArea(box);
    const sources = [];
    const notices = [];
    if (overlaps(box, DIGITRAFFIC_AREA)) {
      const pending = this.refreshDigitraffic();
      // Wait for the very first load so the first answer isn't empty; afterwards refresh in the background.
      if (pending && !this.dt.lastLocations) await pending;
      if (this.dt.error) notices.push(`Digitraffic unavailable (${this.dt.error}).`);
      else sources.push('digitraffic');
    }
    if (this.openStream) {
      if (this.streamStatus === 'open') sources.push('aisstream');
      else notices.push(`aisstream.io ${this.streamStatus}.`);
    } else if (!overlaps(box, DIGITRAFFIC_AREA)) {
      notices.push('Worldwide ships need an aisstream.io API key (AISSTREAM_API_KEY).');
    }
    let ships = [];
    for (const ship of this.ships.values()) if (ship.la !== null && inBox(ship, box)) ships.push(ship);
    if (ships.length > MAX_RESULTS) {
      ships.sort((a, b) => (b.s ?? 0) - (a.s ?? 0));
      ships = ships.slice(0, MAX_RESULTS);
    }
    return { sources, notices, ships };
  }

  get(id) {
    const ship = this.ships.get(String(id));
    return ship && ship.la !== null ? ship : null;
  }

  /** Name, MMSI, IMO or call sign. */
  search(query, limit = 25) {
    const q = String(query || '').trim().toUpperCase();
    if (q.length < 3) return [];
    const digits = /^\d+$/.test(q);
    const exact = [];
    const partial = [];
    for (const ship of this.ships.values()) {
      if (ship.la === null) continue;
      if (ship.id === q || String(ship.imo) === q || ship.cs.toUpperCase() === q || ship.n.toUpperCase() === q) exact.push(ship);
      else if (!digits && ship.n.toUpperCase().includes(q)) partial.push(ship);
      if (exact.length >= limit) break;
    }
    return [...exact, ...partial.sort((a, b) => a.n.localeCompare(b.n))].slice(0, limit);
  }

  status() {
    let positioned = 0;
    for (const s of this.ships.values()) if (s.la !== null) positioned++;
    return {
      ships: positioned,
      aisstream: this.openStream ? { status: this.streamStatus, messages: this.streamMessages } : 'no API key',
      digitraffic: { lastUpdateSecAgo: this.dt.lastLocations ? Math.round((Date.now() - this.dt.lastLocations) / 1000) : null, error: this.dt.error },
    };
  }
}

function overlaps(box, area) {
  if (box.lamax < area.lamin || box.lamin > area.lamax) return false;
  if (box.lomin <= box.lomax) return box.lomax >= area.lomin && box.lomin <= area.lomax;
  return box.lomin <= area.lomax || box.lomax >= area.lomin;
}

/**
 * aisstream.io connection using the standard WebSocket API (Node 22+, browsers excluded by aisstream).
 * Reconnects with backoff and re-sends the latest subscription.
 */
export function webSocketAisStream(apiKey, WebSocketImpl = globalThis.WebSocket) {
  return ({ onMessage, onStatus }) => {
    let socket = null;
    let boxes = [[[-90, -180], [90, 180]]];
    let retryMs = 2000;
    let closed = false;
    const types = ['PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport', 'ShipStaticData', 'StaticDataReport'];
    const send = () => {
      if (socket?.readyState === 1) socket.send(JSON.stringify({ APIKey: apiKey, BoundingBoxes: boxes, FilterMessageTypes: types }));
    };
    const decoder = new TextDecoder();
    const connect = () => {
      if (closed) return;
      onStatus('connecting');
      socket = new WebSocketImpl('wss://stream.aisstream.io/v0/stream');
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => {
        retryMs = 2000;
        onStatus('open');
        send(); // must arrive within 3 s of connecting
      };
      socket.onmessage = (ev) => onMessage(typeof ev.data === 'string' ? ev.data : decoder.decode(ev.data));
      socket.onerror = () => onStatus('error');
      socket.onclose = () => {
        onStatus('reconnecting');
        setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, 5 * 60 * 1000);
      };
    };
    connect();
    return {
      subscribe(next) {
        boxes = next;
        send();
      },
      close() {
        closed = true;
        socket?.close();
      },
    };
  };
}
