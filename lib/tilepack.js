// Reads vector tiles from the packed offline base map (public/map/tiles.bin + tiles.idx, built by
// scripts/build-basemap.mjs). The index is sorted [tileId, offset, length] uint32 triples.

import fs from 'node:fs';

export class TilePack {
  constructor(dir) {
    this.binPath = `${dir}/tiles.bin`;
    this.idxPath = `${dir}/tiles.idx`;
    this.index = null;
    this.fd = null;
  }

  get available() {
    return fs.existsSync(this.binPath) && fs.existsSync(this.idxPath);
  }

  load() {
    if (this.index) return true;
    if (!this.available) return false;
    const buf = fs.readFileSync(this.idxPath);
    this.index = new Uint32Array(buf.buffer, buf.byteOffset, buf.length / 4);
    this.fd = fs.openSync(this.binPath, 'r');
    return true;
  }

  /** Tile bytes, or an empty buffer for tiles without data (open sea). Null if no pack is installed. */
  get(z, x, y) {
    if (!this.load()) return null;
    const id = (4 ** z - 1) / 3 + y * 2 ** z + x;
    let lo = 0;
    let hi = this.index.length / 3 - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const v = this.index[mid * 3];
      if (v === id) {
        const out = Buffer.alloc(this.index[mid * 3 + 2]);
        fs.readSync(this.fd, out, 0, out.length, this.index[mid * 3 + 1]);
        return out;
      }
      if (v < id) lo = mid + 1;
      else hi = mid - 1;
    }
    return Buffer.alloc(0);
  }
}
