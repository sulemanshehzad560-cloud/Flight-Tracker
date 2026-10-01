import test from 'node:test';
import assert from 'node:assert/strict';
import { fromOpenSky, fromReadsb, mergeAircraft, inBox, boxCircle } from '../lib/normalize.js';
import { callsignCandidates, flightNumberForCallsign, airlineForCallsign } from '../public/js/airlines.js';
import { TtlCache } from '../lib/cache.js';

test('OpenSky state vectors are converted to feet, knots and ft/min', () => {
  const sv = ['4ca7b5', 'RYR12AB ', 'Ireland', 1700000000, 1700000001, -6.27, 53.42, 10668, false, 231.5, 87.3, -5.2, null, 10900, '7700', false, 0, 4];
  const ac = fromOpenSky(sv, 1700000002);
  assert.equal(ac.h, '4ca7b5');
  assert.equal(ac.c, 'RYR12AB');
  assert.equal(ac.a, 35000);
  assert.equal(ac.s, 450);
  assert.equal(ac.v, -1024);
  assert.equal(ac.ct, 'A3');
  assert.equal(ac.ts, 1700000000 * 1000);
  assert.equal(ac.q, '7700');
});

test('OpenSky vectors without a position are dropped', () => {
  assert.equal(fromOpenSky(['abc123', 'X', 'Y', null, 1, null, null], 1), null);
});

test('readsb aircraft keep registration, type and ground state', () => {
  const now = 1_700_000_000_000;
  const ac = fromReadsb({ hex: '~a1b2c3', flight: 'UAL1 ', r: 'N12345', t: 'B789', alt_baro: 'ground', gs: 12, track: 270, lat: 37.6, lon: -122.4, seen_pos: 2, dbFlags: 1 }, now, 'adsb.lol');
  assert.equal(ac.h, 'a1b2c3');
  assert.equal(ac.c, 'UAL1');
  assert.equal(ac.g, true);
  assert.equal(ac.a, 0);
  assert.equal(ac.m, true);
  assert.equal(ac.ts, now - 2000);
});

test('merge prefers the newest position and fills missing fields', () => {
  const older = { h: 'aaa111', c: 'BAW1', r: 'G-XLEA', t: 'A388', la: 1, lo: 1, ts: 1000 };
  const newer = { h: 'aaa111', c: 'BAW1', r: '', t: '', la: 2, lo: 2, ts: 2000 };
  const [m] = mergeAircraft([older], [newer]);
  assert.equal(m.la, 2);
  assert.equal(m.r, 'G-XLEA');
  assert.equal(m.t, 'A388');
});

test('bounding boxes across the antimeridian', () => {
  const box = { lamin: -10, lamax: 10, lomin: 170, lomax: -170 };
  assert.equal(inBox({ la: 0, lo: 175 }, box), true);
  assert.equal(inBox({ la: 0, lo: -175 }, box), true);
  assert.equal(inBox({ la: 0, lo: 0 }, box), false);
  const c = boxCircle(box);
  assert.ok(Math.abs(Math.abs(c.lon) - 180) < 1e-9);
});

test('flight numbers map to ICAO callsigns', () => {
  assert.deepEqual(callsignCandidates('ba 117').sort(), ['BA117', 'BAW117'].sort());
  assert.ok(callsignCandidates('PK785').includes('PIA785'));
  assert.ok(callsignCandidates('EK0003').includes('UAE3'));
  assert.ok(callsignCandidates('BAW0117').includes('BAW117'));
  assert.equal(flightNumberForCallsign('UAE202'), 'EK202');
  assert.equal(flightNumberForCallsign('N12345'), null);
  assert.equal(airlineForCallsign('DLH400').name, 'Lufthansa');
});

test('cache de-duplicates concurrent loads', async () => {
  const cache = new TtlCache();
  let calls = 0;
  const load = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 10));
    return 42;
  };
  const [a, b] = await Promise.all([cache.wrap('k', 1000, load), cache.wrap('k', 1000, load)]);
  assert.equal(a, 42);
  assert.equal(b, 42);
  assert.equal(calls, 1);
  assert.equal(await cache.wrap('k', 1000, load), 42);
  assert.equal(calls, 1);
});
