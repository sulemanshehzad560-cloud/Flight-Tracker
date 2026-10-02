// Ship helpers: AIS type categories (colours follow the usual marine-traffic conventions),
// navigational status names and formatting.

export const SHIP_CATEGORIES = {
  cargo: { label: 'Cargo', color: '#4ade80' },
  tanker: { label: 'Tanker', color: '#f87171' },
  passenger: { label: 'Passenger', color: '#60a5fa' },
  highspeed: { label: 'High speed', color: '#facc15' },
  special: { label: 'Tug / special', color: '#22d3ee' },
  fishing: { label: 'Fishing', color: '#fb923c' },
  pleasure: { label: 'Pleasure / sailing', color: '#e879f9' },
  other: { label: 'Other / unknown', color: '#cbd5e1' },
};

const TYPE_NAMES = {
  30: 'Fishing', 31: 'Towing', 32: 'Towing (large)', 33: 'Dredging', 34: 'Diving operations', 35: 'Military',
  36: 'Sailing', 37: 'Pleasure craft', 50: 'Pilot vessel', 51: 'Search and rescue', 52: 'Tug', 53: 'Port tender',
  54: 'Anti-pollution', 55: 'Law enforcement', 58: 'Medical transport', 59: 'Special craft',
};

export function shipCategory(type) {
  const t = Number(type) || 0;
  if (t >= 70 && t <= 79) return 'cargo';
  if (t >= 80 && t <= 89) return 'tanker';
  if (t >= 60 && t <= 69) return 'passenger';
  if ((t >= 40 && t <= 49) || (t >= 20 && t <= 29)) return 'highspeed';
  if (t === 30) return 'fishing';
  if (t === 36 || t === 37) return 'pleasure';
  if ((t >= 31 && t <= 35) || (t >= 50 && t <= 59)) return 'special';
  return 'other';
}

export function shipTypeName(type) {
  const t = Number(type) || 0;
  if (TYPE_NAMES[t]) return TYPE_NAMES[t];
  if (t >= 20 && t <= 29) return 'Wing in ground';
  if (t >= 40 && t <= 49) return 'High-speed craft';
  if (t >= 60 && t <= 69) return 'Passenger';
  if (t >= 70 && t <= 79) return 'Cargo';
  if (t >= 80 && t <= 89) return 'Tanker';
  if (t >= 90 && t <= 99) return 'Other';
  return 'Unknown type';
}

export const NAV_STATUS = {
  0: 'Under way', 1: 'At anchor', 2: 'Not under command', 3: 'Restricted',
  4: 'Draught-limited', 5: 'Moored', 6: 'Aground', 7: 'Fishing', 8: 'Sailing',
  14: 'Emergency beacon',
};

/** Stopped = moored / at anchor / aground, or barely moving. */
export function isStopped(ship) {
  return ship.ns === 1 || ship.ns === 5 || ship.ns === 6 || (ship.s ?? 0) < 0.5;
}

export function shipColor(ship) {
  return SHIP_CATEGORIES[shipCategory(ship.t)].color;
}

/** Bigger icon for bigger ships. */
export function shipSize(ship) {
  const l = ship.l || 0;
  return l >= 250 ? 1.25 : l >= 150 ? 1.1 : l >= 60 ? 0.95 : l > 0 ? 0.8 : 0.9;
}
