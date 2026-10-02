import test from 'node:test';
import assert from 'node:assert/strict';
import { ShipTracker, parseAisTime } from '../lib/ships.js';
import { setFetch } from '../lib/providers.js';

const position = {
  MessageType: 'PositionReport',
  MetaData: { MMSI: 538009000, ShipName: 'EVER GIVEN@@@ ', latitude: 30.01, longitude: 32.58, time_utc: '2026-10-02 10:15:30.123456789 +0000 UTC' },
  Message: { PositionReport: { UserID: 538009000, Latitude: 30.01, Longitude: 32.58, Sog: 12.4, Cog: 341.2, TrueHeading: 511, NavigationalStatus: 0 } },
};
const statics = {
  MessageType: 'ShipStaticData',
  MetaData: { MMSI: 538009000, ShipName: 'EVER GIVEN', time_utc: '2026-10-02 10:16:00.0 +0000 UTC' },
  Message: { ShipStaticData: { UserID: 538009000, Name: 'EVER GIVEN', Type: 71, CallSign: 'H3RC ', ImoNumber: 9811000, Destination: 'ROTTERDAM@@', MaximumStaticDraught: 14.5, Dimension: { A: 300, B: 100, C: 30, D: 29 }, Eta: { Month: 10, Day: 9, Hour: 6, Minute: 0 } } },
};

test('AIS timestamps with nanoseconds parse to milliseconds', () => {
  assert.equal(parseAisTime('2026-10-02 10:15:30.123456789 +0000 UTC'), Date.UTC(2026, 9, 2, 10, 15, 30, 123));
  assert.equal(parseAisTime('nonsense'), null);
});

test('aisstream position and static messages build one ship', () => {
  const t = new ShipTracker();
  t.handleAisMessage(JSON.stringify(position));
  t.handleAisMessage(statics);
  const s = t.get('538009000');
  assert.equal(s.n, 'EVER GIVEN');
  assert.equal(s.s, 12.4);
  assert.equal(s.h, null); // 511 = not available
  assert.equal(s.t, 71);
  assert.equal(s.cs, 'H3RC');
  assert.equal(s.d, 'ROTTERDAM');
  assert.equal(s.l, 400);
  assert.equal(s.w, 59);
  assert.equal(s.eta, '10-09 06:00');
  assert.deepEqual(t.search('ever').map((x) => x.id), ['538009000']);
  assert.deepEqual(t.search('9811000').map((x) => x.id), ['538009000']);
});

test('older positions never overwrite newer ones; invalid positions are ignored', () => {
  const t = new ShipTracker();
  t.handleAisMessage(position);
  t.handleAisMessage({ ...position, MetaData: { ...position.MetaData, time_utc: '2026-10-02 09:00:00 +0000 UTC' }, Message: { PositionReport: { ...position.Message.PositionReport, Latitude: 10 } } });
  t.handleAisMessage({ ...position, MetaData: { ...position.MetaData, MMSI: 1 }, Message: { PositionReport: { UserID: 1, Latitude: 91, Longitude: 181 } } });
  assert.equal(t.get('538009000').la, 30.01);
  assert.equal(t.get('1'), null);
});

test('Digitraffic locations and metadata (Baltic, no key)', async () => {
  const responses = {
    '/locations': { dataUpdatedTime: '2026-10-02T10:00:00Z', features: [{ mmsi: 230000001, type: 'Feature', geometry: { type: 'Point', coordinates: [24.95, 60.16] }, properties: { mmsi: 230000001, sog: 9.8, cog: 120.5, navStat: 0, heading: 118, timestampExternal: Date.UTC(2026, 9, 2, 9, 59) } }] },
    '/vessels': [{ mmsi: 230000001, name: 'FINLANDIA', shipType: 60, callSign: 'OJMA', imo: 9214379, destination: 'TALLINN', draught: 68, eta: (10 << 16) | (2 << 11) | (12 << 6) | 30, referencePointA: 150, referencePointB: 25, referencePointC: 15, referencePointD: 12 }],
  };
  const requested = [];
  setFetch(async (url, opts) => {
    requested.push([url, opts.headers]);
    const body = JSON.stringify(Object.entries(responses).find(([k]) => url.includes(k))[1]);
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => body };
  });
  try {
    const t = new ShipTracker();
    const { ships, sources } = await t.inBox({ lamin: 59, lamax: 61, lomin: 23, lomax: 26 });
    assert.deepEqual(sources, ['digitraffic']);
    assert.equal(ships.length, 1);
    const s = ships[0];
    assert.equal(s.n, 'FINLANDIA');
    assert.equal(s.dr, 6.8);
    assert.equal(s.eta, '10-02 12:30');
    assert.equal(s.l, 175);
    assert.ok(requested.every(([, h]) => h['Digitraffic-User']));
    // Outside the Baltic, without an aisstream key: no ships and a hint.
    const far = await t.inBox({ lamin: 0, lamax: 5, lomin: 100, lomax: 105 });
    assert.equal(far.ships.length, 0);
    assert.match(far.notices.join(' '), /AISSTREAM_API_KEY/);
  } finally {
    setFetch((...args) => fetch(...args));
  }
});

test('phone stream follows the view, splitting boxes at the antimeridian', () => {
  const subs = [];
  const t = new ShipTracker({ globalStream: false, openStream: () => ({ subscribe: (b) => subs.push(b), close() {} }) });
  t.followArea({ lamin: 10, lamax: 20, lomin: 170, lomax: 178 });
  assert.equal(subs.length, 1);
  assert.equal(subs[0].length, 2);
  t.followArea({ lamin: 10, lamax: 20, lomin: 170, lomax: 178 });
  assert.equal(subs.length, 1); // unchanged view: no re-subscription
});
