// Aircraft silhouettes drawn on a canvas and turned into signed-distance-field (SDF) images,
// so MapLibre can tint each plane by altitude and draw a crisp outline (halo) at any size.
// All shapes point north (nose up); the map rotates them by the aircraft's track.

const SIZE = 64; // drawn at 2x, so 32 CSS px at icon-size 1
const RADIUS = 8; // SDF spread in px

function mirrored(half) {
  // `half` is the right-hand outline from nose to tail; mirror it for the left side.
  const left = half.slice().reverse().map(([x, y]) => [64 - x, y]);
  return [...half, ...left];
}

function polygon(ctx, points) {
  ctx.beginPath();
  points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.fill();
}

const SHAPES = {
  airliner(ctx) {
    polygon(ctx, mirrored([
      [32, 6], [34, 9], [35, 14], [35, 24], [58, 37], [58, 41], [35, 34], [35, 46],
      [44, 52], [44, 55], [34, 53.5], [32.6, 58],
    ]));
  },
  heavy(ctx) {
    polygon(ctx, mirrored([
      [32, 5], [34.5, 8], [36, 14], [36, 22], [47, 29], [47, 26], [49, 26], [49, 31], [60, 37],
      [60, 41.5], [36, 34], [36, 46], [46, 52], [46, 55.5], [34.5, 54], [32.6, 59],
    ]));
  },
  light(ctx) {
    polygon(ctx, mirrored([
      [32, 10], [33.8, 13], [34, 21], [59, 22], [59, 27.5], [34, 28.5], [33, 44], [41, 46],
      [41, 49.5], [32.6, 50.5],
    ]));
  },
  glider(ctx) {
    polygon(ctx, mirrored([
      [32, 14], [33.2, 17], [33.2, 23], [61, 24.5], [61, 27], [33.2, 27.5], [32.8, 46], [38, 47],
      [38, 49.5], [32.5, 50],
    ]));
  },
  fast(ctx) {
    polygon(ctx, mirrored([
      [32, 5], [34, 12], [35, 22], [53, 44], [53, 48], [36, 45], [36, 50], [42, 55], [42, 58], [32.6, 57],
    ]));
  },
  heli(ctx) {
    ctx.beginPath();
    ctx.ellipse(32, 30, 7, 9, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(30.5, 36, 3, 18);
    ctx.fillRect(25, 51, 14, 3);
    ctx.save();
    ctx.translate(32, 29);
    for (const angle of [Math.PI / 4, -Math.PI / 4]) {
      ctx.save();
      ctx.rotate(angle);
      ctx.fillRect(-24, -1.6, 48, 3.2);
      ctx.restore();
    }
    ctx.restore();
  },
  balloon(ctx) {
    ctx.beginPath();
    ctx.arc(32, 28, 13, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(29, 43, 6, 6);
  },
  // Ships: a hull pointing north (bow up) while under way; a diamond when stopped / moored.
  // Ship seen from above, bow up: pointed bow, cargo deck with hatch gaps, bridge block at the stern.
  ship(ctx) {
    polygon(ctx, mirrored([[32, 2], [36.5, 7], [40, 15], [42, 25], [42, 55], [40.5, 59.5], [32.6, 61]]));
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    for (const y of [19, 27, 35]) ctx.fillRect(25, y, 14, 2.6); // gaps between cargo hatches
    ctx.fillRect(25, 43, 14, 2.2); // gap in front of the bridge
    ctx.beginPath(); // bow (forecastle) line
    ctx.moveTo(26.5, 13);
    ctx.lineTo(32, 9);
    ctx.lineTo(37.5, 13);
    ctx.lineWidth = 2.2;
    ctx.stroke();
    ctx.restore();
  },
  // Kept for older references: stopped ships now use the same ship silhouette (drawn more faintly).
  'ship-stopped'(ctx) {
    SHAPES.ship(ctx);
  },
  ground(ctx) {
    ctx.beginPath();
    ctx.roundRect(25, 18, 14, 28, 4);
    ctx.fill();
  },
};

/** Emitter category ("A3", ...) -> [icon name, relative size]. */
export function iconForCategory(category, typeCode = '') {
  switch (category) {
    case 'A1': return ['light', 0.8];
    case 'A2': return ['light', 0.95];
    case 'A3': return ['airliner', 1];
    case 'A4': return ['airliner', 1.05];
    case 'A5': return ['heavy', 1.25];
    case 'A6': return ['fast', 0.95];
    case 'A7': return ['heli', 0.9];
    case 'B1': case 'B4': return ['glider', 0.85];
    case 'B2': return ['balloon', 0.8];
    case 'B6': return ['light', 0.6];
    case 'C1': case 'C2': case 'C3': return ['ground', 0.6];
    default: break;
  }
  // No category broadcast: guess from the ICAO type designator when we have one.
  if (/^(A38|A34|A35|A33|B74|B77|B78|B76|A30|MD11|IL96|AN12|C5|C17)/.test(typeCode)) return ['heavy', 1.25];
  if (/^(C1[5-8]|C2|PA|SR2|DA[24]|BE[23]|P28|M20|TB)/.test(typeCode)) return ['light', 0.85];
  if (/^(EC|AS3|AS5|H1|H6|R44|R22|B06|B407|B429|S76|S92|AW1|A109|A139|A169|NH90|UH|H47|H60)/.test(typeCode)) return ['heli', 0.9];
  return ['airliner', 1];
}

/** Signed distance field (TinySDF convention: edge at 0.75, inside brighter). */
function toSdf(alpha) {
  const n = SIZE * SIZE;
  const inside = new Uint8Array(n);
  for (let i = 0; i < n; i++) inside[i] = alpha[i * 4 + 3] > 127 ? 1 : 0;
  const offsets = [];
  for (let dy = -RADIUS; dy <= RADIUS; dy++) {
    for (let dx = -RADIUS; dx <= RADIUS; dx++) {
      const d = Math.hypot(dx, dy);
      if (d <= RADIUS && d > 0) offsets.push([dx, dy, d]);
    }
  }
  offsets.sort((a, b) => a[2] - b[2]);
  const out = new Uint8ClampedArray(n * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x;
      const self = inside[i];
      let dist = RADIUS;
      for (const [dx, dy, d] of offsets) {
        const nx = x + dx;
        const ny = y + dy;
        const other = nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE ? 0 : inside[ny * SIZE + nx];
        if (other !== self) {
          dist = d - 0.5;
          break;
        }
      }
      const signed = self ? -dist : dist;
      out[i * 4 + 3] = Math.round(255 - 255 * (signed / RADIUS + 0.25));
    }
  }
  return out;
}

let cached = null;

/** { name: ImageData } for every silhouette. */
export function buildIcons() {
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  cached = {};
  for (const [name, draw] of Object.entries(SHAPES)) {
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.fillStyle = '#000';
    draw(ctx);
    const data = ctx.getImageData(0, 0, SIZE, SIZE).data;
    cached[name] = new ImageData(toSdf(data), SIZE, SIZE);
  }
  return cached;
}

/** Plain (non-SDF) data-URL silhouette for use in HTML (search results, panel header). */
export function iconDataUrl(name, color = '#fff') {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = color;
  (SHAPES[name] || SHAPES.airliner)(ctx);
  return canvas.toDataURL();
}
