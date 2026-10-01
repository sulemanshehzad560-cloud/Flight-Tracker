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
import { OpenSkyGlobal } from './lib/providers.js';
import { createApi } from './lib/api.js';
import { DemoTraffic } from './lib/demo.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const DEMO = process.env.DEMO === '1' || process.argv.includes('--demo');

const opensky = new OpenSkyGlobal({
  clientId: process.env.OPENSKY_CLIENT_ID,
  clientSecret: process.env.OPENSKY_CLIENT_SECRET,
  ttlSec: Number(process.env.OPENSKY_REFRESH_SEC) || undefined,
});
const demo = DEMO ? new DemoTraffic(Number(process.env.DEMO_AIRCRAFT) || 4000) : null;
const routeApi = createApi({ opensky, demo, statusExtra: () => ({ uptimeSec: Math.round(process.uptime()) }) });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

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
