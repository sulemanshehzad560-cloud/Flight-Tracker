#!/usr/bin/env node
// Builds the offline base map into public/map/ so neither the website nor the Android app needs an
// online tile server for it:
//
//   tiles.bin + tiles.idx  Vector tiles, zoom 0-9 (the map overzooms beyond that), packed into one file.
//                          tiles.idx holds sorted [tileId, offset, length] uint32 triples (little endian),
//                          tileId = (4^z - 1) / 3 + y * 2^z + x. Served as /map/tiles/{z}/{x}/{y}.pbf by
//                          server.js and by the Android app; missing tiles are empty (open sea).
//                            land, coastline, borders – Natural Earth 1:10m (via world-atlas, public domain)
//                            countries                – country label points
//                            cities                   – GeoNames cities ≥ 15 000 people (all-the-cities, CC BY 4.0)
//                            airports                 – large & medium airports (OurAirports, public domain)
//   airports.json          Airport list for search and the airport panel
//   glyphs/noto/*.pbf      Noto Sans label glyphs (smp-noto-glyphs, MIT / OFL)
//   manifest.json          What was built (the app checks it to offer the built-in map)
//
// Run with: npm run basemap   (needs the devDependencies: npm install)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { feature, mesh } from 'topojson-client';
import geojsonvt from 'geojson-vt';
import vtpbf from 'vt-pbf';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'public', 'map');
const MAX_ZOOM = Number(process.env.BASEMAP_MAX_ZOOM) || 9;
const started = Date.now();

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'glyphs', 'noto'), { recursive: true });

const fc = (features) => ({ type: 'FeatureCollection', features });
const pt = (lon, lat, properties) => ({ type: 'Feature', properties, geometry: { type: 'Point', coordinates: [lon, lat] } });

// ------------------------------------------------------------------ Natural Earth geometry
const land = require('world-atlas/land-10m.json');
const countries = require('world-atlas/countries-10m.json');
/** Make polygon rings continuous across the antimeridian (geojson-vt then wraps them correctly). */
function unwrapRing(ring) {
  let offset = 0;
  return ring.map((p, i) => {
    if (i > 0) {
      const d = p[0] + offset - (ring[i - 1][0] + prevOffset);
      if (d > 180) offset -= 360;
      else if (d < -180) offset += 360;
    }
    prevOffset = offset;
    return [p[0] + offset, p[1]];
  });
}
let prevOffset = 0;
function unwrapPolygons(geometry) {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  return { type: 'MultiPolygon', coordinates: polys.map((poly) => poly.map((ring) => { prevOffset = 0; return unwrapRing(ring); })) };
}
const landRaw = feature(land, land.objects.land);
const landFc = { type: 'FeatureCollection', features: landRaw.features.map((f) => ({ ...f, geometry: unwrapPolygons(f.geometry) })) };
/** Split lines where they jump across the antimeridian, so they aren't drawn across the whole world. */
function splitAntimeridian(geometry) {
  const lines = geometry.type === 'LineString' ? [geometry.coordinates] : geometry.coordinates;
  const out = [];
  for (const line of lines) {
    let current = [line[0]];
    for (let i = 1; i < line.length; i++) {
      if (Math.abs(line[i][0] - line[i - 1][0]) > 180) {
        if (current.length > 1) out.push(current);
        current = [];
      }
      current.push(line[i]);
    }
    if (current.length > 1) out.push(current);
  }
  return { type: 'MultiLineString', coordinates: out };
}
const coastline = splitAntimeridian(mesh(land, land.objects.land));
const borders = splitAntimeridian(mesh(countries, countries.objects.countries, (a, b) => a !== b));

/** Label point: area-weighted centroid of the country's largest polygon. */
function labelPoint(geometry) {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  let best = null;
  let bestArea = 0;
  for (const poly of polys) {
    const ring = poly[0];
    let a = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
      a += f;
      cx += (ring[j][0] + ring[i][0]) * f;
      cy += (ring[j][1] + ring[i][1]) * f;
    }
    if (Math.abs(a) > bestArea) {
      bestArea = Math.abs(a);
      best = [cx / (3 * a), cy / (3 * a)];
    }
  }
  return best ? { point: best, area: bestArea / 2 } : null;
}
const countryLabels = [];
for (const f of feature(countries, countries.objects.countries).features) {
  const label = f.geometry && labelPoint(f.geometry);
  if (label && f.properties.name) countryLabels.push(pt(label.point[0], label.point[1], { name: f.properties.name, area: Math.round(label.area) }));
}

// ------------------------------------------------------------------ cities (by population tier)
const cityTiers = [[], [], [], []]; // ≥1M, ≥250k, ≥60k, ≥15k
const allCities = require('all-the-cities');
for (const c of allCities) {
  if (c.population < 15000 || !c.loc?.coordinates) continue;
  const tier = c.population >= 1e6 ? 0 : c.population >= 2.5e5 ? 1 : c.population >= 6e4 ? 2 : 3;
  const [lon, lat] = c.loc.coordinates;
  cityTiers[tier].push(pt(lon, lat, { name: c.name, pop: c.population }));
}

// ------------------------------------------------------------------ airports
const airportsRaw = require('airports-json/data/airports.json');
const countryNames = Object.fromEntries(require('airports-json/data/countries.json').map((c) => [c.code, c.name]));
const airports = airportsRaw
  .map((a) => ({
    iata: a.iata_code || '',
    icao: a.gps_code || a.ident || '',
    name: a.name,
    city: a.municipality || '',
    country: countryNames[a.iso_country] || a.iso_country,
    cc: a.iso_country,
    lat: +(+a.latitude_deg).toFixed(4),
    lon: +(+a.longitude_deg).toFixed(4),
    elev: a.elevation_ft === '' ? null : Number(a.elevation_ft),
    large: a.type === 'large_airport',
    wiki: a.wikipedia_link || '',
  }))
  .filter((a) => Number.isFinite(a.lat) && Number.isFinite(a.lon));
fs.writeFileSync(path.join(OUT, 'airports.json'), JSON.stringify(airports));
const airportPoints = airports.map((a) => pt(a.lon, a.lat, { code: a.iata || a.icao, icao: a.icao, name: a.name, large: a.large ? 1 : 0 }));

// ------------------------------------------------------------------ tiles
const layers = {
  land: landFc,
  coastline: fc([{ type: 'Feature', properties: {}, geometry: coastline }]),
  borders: fc([{ type: 'Feature', properties: {}, geometry: borders }]),
  countries: fc(countryLabels),
  cities1: fc(cityTiers[0]),
  cities2: fc(cityTiers[1]),
  cities3: fc(cityTiers[2]),
  cities4: fc(cityTiers[3]),
  airports: fc(airportPoints),
};
// Smaller layers are only needed from a certain zoom: skip them below that to keep low-zoom tiles light.
const minZoom = { cities2: 3, cities3: 5, cities4: 7, airports: 3 };

const indexes = {};
for (const [name, data] of Object.entries(layers)) {
  indexes[name] = geojsonvt(data, { maxZoom: MAX_ZOOM, indexMaxZoom: MAX_ZOOM, indexMaxPoints: 0, tolerance: 2, buffer: 64 });
  console.log(`indexed ${name} (${data.features.length} features)`);
}

const tileKeys = new Set();
for (const index of Object.values(indexes)) for (const { z, x, y } of index.tileCoords) tileKeys.add(`${z}/${x}/${y}`);

const tileId = (z, x, y) => (4 ** z - 1) / 3 + y * 2 ** z + x;
const entries = [];
const chunks = [];
let tiles = 0;
let bytes = 0;
for (const key of tileKeys) {
  const [z, x, y] = key.split('/').map(Number);
  const tileLayers = {};
  for (const [name, index] of Object.entries(indexes)) {
    if ((minZoom[name] || 0) > z) continue;
    const t = index.getTile(z, x, y);
    if (t && t.features.length) tileLayers[name] = t;
  }
  if (!Object.keys(tileLayers).length) continue;
  const buf = vtpbf.fromGeojsonVt(tileLayers, { version: 2 });
  entries.push([tileId(z, x, y), bytes, buf.length]);
  chunks.push(Buffer.from(buf));
  tiles++;
  bytes += buf.length;
}
entries.sort((a, b) => a[0] - b[0]);
const idx = Buffer.alloc(entries.length * 12);
entries.forEach(([id, off, len], i) => {
  idx.writeUInt32LE(id, i * 12);
  idx.writeUInt32LE(off, i * 12 + 4);
  idx.writeUInt32LE(len, i * 12 + 8);
});
fs.writeFileSync(path.join(OUT, 'tiles.bin'), Buffer.concat(chunks));
fs.writeFileSync(path.join(OUT, 'tiles.idx'), idx);
console.log(`wrote ${tiles} tiles, ${(bytes / 1048576).toFixed(1)} MB`);

// ------------------------------------------------------------------ glyphs
const glyphDir = path.join(path.dirname(require.resolve('smp-noto-glyphs/package.json')), 'fixtures', 'glyphs');
let glyphBytes = 0;
for (const file of fs.readdirSync(glyphDir)) {
  if (!file.endsWith('.pbf.gz')) continue;
  const data = zlib.gunzipSync(fs.readFileSync(path.join(glyphDir, file)));
  fs.writeFileSync(path.join(OUT, 'glyphs', 'noto', file.replace(/\.gz$/, '')), data);
  glyphBytes += data.length;
}
console.log(`wrote glyphs, ${(glyphBytes / 1048576).toFixed(1)} MB`);

fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({
  maxZoom: MAX_ZOOM,
  tiles,
  airports: airports.length,
  built: new Date().toISOString(),
  attribution: 'Natural Earth · GeoNames (CC BY 4.0) · OurAirports',
}));
console.log(`done in ${((Date.now() - started) / 1000).toFixed(0)}s`);
