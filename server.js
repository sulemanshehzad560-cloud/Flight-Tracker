#!/usr/bin/env node
// Flight Tracker server: serves the web app and a small JSON API that aggregates free
// live ADS-B data sources (see lib/providers.js). No dependencies – Node.js 18+ only.
//
//   PORT=8080 node server.js
//   OPENSKY_CLIENT_ID=... OPENSKY_CLIENT_SECRET=... node server.js   # more frequent world updates
//   DEMO=1 node server.js                                             # simulated traffic, no network

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { boxCircle, mergeAircraft, inBox } from './lib/normalize.js';
import {
  OpenSkyGlobal, aircraftNear, aircraftByCallsign, aircraftByRegistration, aircraftByHex,
  routeForCallsign, aircraftDetails,
} from './lib/providers.js';
import { DemoTraffic } from './lib/demo.js';
import { callsignCandidates, airlinePrefixes } from './public/js/airlines.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const DEMO = process.env.DEMO === '1' || process.argv.includes('--demo');
// A circle up to this radius is served by the detailed regional feeds instead of OpenSky.
const REGIONAL_MAX_NM = 250;

const opensky = new OpenSkyGlobal({
  clientId: process.env.OPENSKY_CLIENT_ID,
  clientSecret: process.env.OPENSKY_CLIENT_SECRET,
  ttlSec: Number(process.env.OPENSKY_REFRESH_SEC) || undefined,
});
const demo = DEMO ? new DemoTraffic(Number(process.env.DEMO_AIRCRAFT) || 4000) : null;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

// ---------------------------------------------------------------------------
// API handlers
// ---------------------------------------------------------------------------

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

function looksLikeHex(q) {
  return /^[0-9a-f]{6}$/i.test(q);
}

function looksLikeRegistration(q) {
  return /^[A-Z0-9]{1,2}-[A-Z0-9]{2,5}$/i.test(q) || /^N\d[0-9A-Z]{0,4}$/i.test(q) || /^[A-Z]{1,2}\d{3,5}$/i.test(q);
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
  return [200, { demo: Boolean(demo), opensky: opensky.status(), uptimeSec: Math.round(process.uptime()) }];
}

async function routeApi(url) {
  const p = url.pathname;
  if (p === '/api/aircraft') return apiAircraft(url.searchParams);
  if (p.startsWith('/api/aircraft/')) return apiAircraftByHex(decodeURIComponent(p.slice('/api/aircraft/'.length)));
  if (p === '/api/search') return apiSearch(url.searchParams);
  if (p === '/api/route') return apiRoute(url.searchParams);
  if (p === '/api/details') return apiDetails(url.searchParams);
  if (p === '/api/track') return apiTrack(url.searchParams);
  if (p === '/api/status') return apiStatus();
  return [404, { error: 'Unknown endpoint' }];
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function send(req, res, status, body, contentType, extraHeaders = {}) {
  const headers = { 'Content-Type': contentType, 'X-Content-Type-Options': 'nosniff', ...extraHeaders };
  const compressible = /json|javascript|css|html|svg/.test(contentType) && body.length > 1024;
  if (compressible && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    headers['Content-Encoding'] = 'gzip';
    headers.Vary = 'Accept-Encoding';
    body = zlib.gzipSync(body, { level: 6 });
  }
  headers['Content-Length'] = body.length;
  res.writeHead(status, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT + path.sep)) return send(req, res, 403, Buffer.from('Forbidden'), 'text/plain');
  try {
    const data = await fs.readFile(file);
    const type = MIME[path.extname(file)] || 'application/octet-stream';
    return send(req, res, 200, data, type, { 'Cache-Control': 'no-cache' });
  } catch {
    // Single-page app: unknown paths get the app shell (deep links like /flight/BAW117).
    if (!path.extname(rel)) {
      const data = await fs.readFile(path.join(ROOT, 'index.html'));
      return send(req, res, 200, data, MIME['.html'], { 'Cache-Control': 'no-cache' });
    }
    return send(req, res, 404, Buffer.from('Not found'), 'text/plain');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(req, res, 405, Buffer.from('Method not allowed'), 'text/plain');
  }
  if (url.pathname.startsWith('/api/')) {
    try {
      const [status, payload] = await routeApi(url);
      return send(req, res, status, Buffer.from(JSON.stringify(payload)), 'application/json', { 'Cache-Control': 'no-store' });
    } catch (err) {
      console.error(`${url.pathname}:`, err.message);
      return send(req, res, 502, Buffer.from(JSON.stringify({ error: err.message })), 'application/json');
    }
  }
  return serveStatic(req, res, url);
});

server.listen(PORT, HOST, () => {
  const mode = demo ? 'DEMO (simulated traffic)' : opensky.authenticated ? 'live, OpenSky account' : 'live, OpenSky anonymous';
  console.log(`✈  Flight Tracker running at http://localhost:${PORT}  [${mode}]`);
});
