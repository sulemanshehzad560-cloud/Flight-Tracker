// Demo mode (DEMO=1): simulated traffic so the app can be developed and tested without
// network access to the real feeds. Aircraft fly great-circle routes between real airports.

import { AIRLINES } from '../public/js/airlines.js';
import { inBox, distanceNm } from './normalize.js';

const AIRPORTS = [
  ['LHR', 'EGLL', 'London Heathrow', 'London', 51.47, -0.4543], ['JFK', 'KJFK', 'John F. Kennedy Intl', 'New York', 40.6413, -73.7781],
  ['DXB', 'OMDB', 'Dubai Intl', 'Dubai', 25.2532, 55.3657], ['SIN', 'WSSS', 'Singapore Changi', 'Singapore', 1.3644, 103.9915],
  ['HND', 'RJTT', 'Tokyo Haneda', 'Tokyo', 35.5494, 139.7798], ['LAX', 'KLAX', 'Los Angeles Intl', 'Los Angeles', 33.9416, -118.4085],
  ['CDG', 'LFPG', 'Paris Charles de Gaulle', 'Paris', 49.0097, 2.5479], ['FRA', 'EDDF', 'Frankfurt', 'Frankfurt', 50.0379, 8.5622],
  ['IST', 'LTFM', 'Istanbul', 'Istanbul', 41.2753, 28.7519], ['DOH', 'OTHH', 'Hamad Intl', 'Doha', 25.2731, 51.6081],
  ['KHI', 'OPKC', 'Jinnah Intl', 'Karachi', 24.9065, 67.1608], ['LHE', 'OPLA', 'Allama Iqbal Intl', 'Lahore', 31.5216, 74.4036],
  ['ISB', 'OPIS', 'Islamabad Intl', 'Islamabad', 33.5491, 72.8256], ['DEL', 'VIDP', 'Indira Gandhi Intl', 'Delhi', 28.5562, 77.1],
  ['SYD', 'YSSY', 'Sydney Kingsford Smith', 'Sydney', -33.9399, 151.1753], ['GRU', 'SBGR', 'São Paulo Guarulhos', 'São Paulo', -23.4356, -46.4731],
  ['JNB', 'FAOR', 'O. R. Tambo Intl', 'Johannesburg', -26.1392, 28.246], ['ORD', 'KORD', "Chicago O'Hare", 'Chicago', 41.9742, -87.9073],
  ['ATL', 'KATL', 'Hartsfield–Jackson', 'Atlanta', 33.6407, -84.4277], ['AMS', 'EHAM', 'Amsterdam Schiphol', 'Amsterdam', 52.3105, 4.7683],
  ['MAD', 'LEMD', 'Madrid Barajas', 'Madrid', 40.4983, -3.5676], ['PEK', 'ZBAA', 'Beijing Capital', 'Beijing', 40.0799, 116.6031],
  ['HKG', 'VHHH', 'Hong Kong Intl', 'Hong Kong', 22.308, 113.9185], ['YYZ', 'CYYZ', 'Toronto Pearson', 'Toronto', 43.6777, -79.6248],
  ['MEX', 'MMMX', 'Mexico City Intl', 'Mexico City', 19.4361, -99.0719], ['CAI', 'HECA', 'Cairo Intl', 'Cairo', 30.1219, 31.4056],
  ['ICN', 'RKSI', 'Seoul Incheon', 'Seoul', 37.4602, 126.4407], ['SFO', 'KSFO', 'San Francisco Intl', 'San Francisco', 37.6213, -122.379],
  ['MIA', 'KMIA', 'Miami Intl', 'Miami', 25.7959, -80.287], ['BKK', 'VTBS', 'Suvarnabhumi', 'Bangkok', 13.69, 100.7501],
].map(([iata, icao, name, city, lat, lon]) => ({ iata, icao, name, city, country: '', countryCode: '', lat, lon }));

const TYPES = [['A320', 'AIRBUS A-320', 'A3'], ['B738', 'BOEING 737-800', 'A3'], ['A21N', 'AIRBUS A-321neo', 'A3'],
  ['B77W', 'BOEING 777-300ER', 'A5'], ['A359', 'AIRBUS A-350-900', 'A5'], ['B789', 'BOEING 787-9', 'A5'],
  ['A388', 'AIRBUS A-380-800', 'A5'], ['E190', 'EMBRAER ERJ-190', 'A3'], ['C172', 'CESSNA 172', 'A1'], ['EC35', 'EUROCOPTER EC-135', 'A7']];

const toRad = Math.PI / 180;

function interpolate(a, b, f) {
  const [lat1, lon1, lat2, lon2] = [a.lat * toRad, a.lon * toRad, b.lat * toRad, b.lon * toRad];
  const d = distanceNm(a.lat, a.lon, b.lat, b.lon) / 3440.065;
  if (d === 0) return [a.lat, a.lon];
  const A = Math.sin((1 - f) * d) / Math.sin(d);
  const B = Math.sin(f * d) / Math.sin(d);
  const x = A * Math.cos(lat1) * Math.cos(lon1) + B * Math.cos(lat2) * Math.cos(lon2);
  const y = A * Math.cos(lat1) * Math.sin(lon1) + B * Math.cos(lat2) * Math.sin(lon2);
  const z = A * Math.sin(lat1) + B * Math.sin(lat2);
  return [Math.atan2(z, Math.hypot(x, y)) / toRad, Math.atan2(y, x) / toRad];
}

function bearing(lat1, lon1, lat2, lon2) {
  const y = Math.sin((lon2 - lon1) * toRad) * Math.cos(lat2 * toRad);
  const x = Math.cos(lat1 * toRad) * Math.sin(lat2 * toRad) - Math.sin(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.cos((lon2 - lon1) * toRad);
  return (Math.atan2(y, x) / toRad + 360) % 360;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export class DemoTraffic {
  constructor(count = 4000) {
    const rand = rng(42);
    this.start = Date.now();
    this.flights = [];
    for (let i = 0; i < count; i++) {
      const o = AIRPORTS[Math.floor(rand() * AIRPORTS.length)];
      let d = AIRPORTS[Math.floor(rand() * AIRPORTS.length)];
      if (d === o) d = AIRPORTS[(AIRPORTS.indexOf(o) + 1) % AIRPORTS.length];
      const airline = AIRLINES[Math.floor(rand() * 100)];
      const type = TYPES[Math.floor(rand() * TYPES.length)];
      const jitter = () => (rand() - 0.5) * 6;
      this.flights.push({
        hex: (0x400000 + i * 37).toString(16),
        callsign: `${airline[1]}${Math.floor(rand() * 2000) + 1}`,
        reg: `${airline[1].slice(0, 1)}-${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + ((i * 7) % 26))}${String.fromCharCode(65 + ((i * 13) % 26))}`,
        type,
        operator: airline[2],
        origin: o,
        destination: d,
        // Offset the endpoints a little so not every flight shares the exact same line.
        a: { lat: o.lat + jitter(), lon: o.lon + jitter() },
        b: { lat: d.lat + jitter(), lon: d.lon + jitter() },
        phase: rand(),
        speedKt: type[2] === 'A1' ? 110 : type[2] === 'A7' ? 120 : 430 + rand() * 60,
        cruiseFt: type[2] === 'A1' ? 4500 : type[2] === 'A7' ? 1500 : Math.round((30000 + rand() * 11000) / 1000) * 1000,
        squawk: String(1000 + Math.floor(rand() * 6000)),
      });
    }
  }

  state(f, now = Date.now()) {
    const total = distanceNm(f.a.lat, f.a.lon, f.b.lat, f.b.lon);
    const hours = total / f.speedKt;
    const frac = (f.phase + (now - this.start) / 3600000 / Math.max(hours, 0.2)) % 1;
    const [lat, lon] = interpolate(f.a, f.b, frac);
    const [lat2, lon2] = interpolate(f.a, f.b, Math.min(1, frac + 0.001));
    const climb = Math.min(1, frac / 0.08, (1 - frac) / 0.1);
    const alt = Math.round((f.cruiseFt * Math.max(0.05, climb)) / 25) * 25;
    const vs = frac < 0.08 ? 1800 : frac > 0.9 ? -1500 : 0;
    return {
      h: f.hex, c: f.callsign, r: f.reg, t: f.type[0], d: f.type[1], o: f.operator, co: '',
      la: +lat.toFixed(5), lo: +lon.toFixed(5), a: alt, ag: alt + 150, g: false,
      s: Math.round(f.speedKt * (0.6 + 0.4 * climb)), k: +bearing(lat, lon, lat2, lon2).toFixed(1), v: vs,
      q: f.squawk, ct: f.type[2], m: false, ts: now, src: 'demo',
    };
  }

  all() {
    const now = Date.now();
    return this.flights.map((f) => this.state(f, now));
  }

  inBox(box) {
    return this.all().filter((ac) => inBox(ac, box));
  }

  find(predicate) {
    return this.all().filter(predicate);
  }

  route(callsign) {
    const f = this.flights.find((x) => x.callsign === callsign);
    if (!f) return null;
    return { source: 'demo', callsign, flightNumber: '', airline: null, origin: f.origin, destination: f.destination, stops: [] };
  }

  details(hex) {
    const f = this.flights.find((x) => x.hex === hex);
    return f ? { hex, registration: f.reg, type: f.type[1], icaoType: f.type[0], manufacturer: '', owner: f.operator, ownerCountry: '', ownerFlag: '', operatorCode: '', photo: null } : null;
  }

  track(hex) {
    const f = this.flights.find((x) => x.hex === hex);
    if (!f) return [];
    const now = Date.now();
    const points = [];
    for (let m = 60; m >= 0; m -= 2) points.push(this.state(f, now - m * 60000));
    return points.map((p) => ({ ts: p.ts, la: p.la, lo: p.lo, a: p.a, k: p.k }));
  }
}
