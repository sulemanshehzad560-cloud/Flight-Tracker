#!/usr/bin/env node
// Connects to aisstream.io with AISSTREAM_API_KEY for a few seconds and reports what arrives,
// parsed by the app's own ShipTracker. Never prints the key. Used by CI as a live health check.
//   AISSTREAM_API_KEY=... node scripts/check-aisstream.mjs
import { ShipTracker } from '../lib/ships.js';

const key = process.env.AISSTREAM_API_KEY;
const SECONDS = Number(process.env.SECONDS) || 25;
if (!key) {
  console.log('AISSTREAM_API_KEY not set – skipping');
  process.exit(0);
}

const tracker = new ShipTracker();
const counts = {};
let raw = 0;
let firstNonData = null;
const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
ws.binaryType = 'arraybuffer';
const decoder = new TextDecoder();
ws.onopen = () => {
  console.log('connected; subscribing to busy shipping areas (English Channel, Singapore Strait, Gulf)');
  ws.send(JSON.stringify({
    APIKey: key,
    BoundingBoxes: [[[49, -6], [52, 3]], [[0.5, 102], [2.5, 105]], [[24, 50], [27, 57]]],
    FilterMessageTypes: ['PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport', 'ShipStaticData', 'StaticDataReport'],
  }));
};
ws.onmessage = (ev) => {
  raw++;
  const text = typeof ev.data === 'string' ? ev.data : decoder.decode(ev.data);
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    if (!firstNonData) firstNonData = text.slice(0, 300);
    return;
  }
  if (!msg.MessageType) {
    if (!firstNonData) firstNonData = text.slice(0, 300);
    return;
  }
  counts[msg.MessageType] = (counts[msg.MessageType] || 0) + 1;
  tracker.handleAisMessage(msg);
};
ws.onerror = (e) => console.log('WebSocket error:', e.message || e.type);
ws.onclose = (e) => console.log(`closed: code ${e.code} ${e.reason || ''}`);

setTimeout(() => {
  ws.close();
  const ships = [...tracker.ships.values()].filter((s) => s.la !== null);
  console.log(`\nmessages received: ${raw}`);
  console.log('by type:', JSON.stringify(counts));
  if (firstNonData) console.log('non-AIS message from server:', firstNonData);
  console.log(`ships with a position: ${ships.length}`);
  for (const s of ships.slice(0, 5)) console.log(`  ${s.id} ${s.n || '(no name yet)'} ${s.la},${s.lo} ${s.s ?? '-'} kn`);
  if (!ships.length) {
    console.log('::warning::aisstream.io delivered no ship positions – check the API key on aisstream.io');
    process.exitCode = 1;
  }
  setTimeout(() => process.exit(), 500);
}, SECONDS * 1000);
