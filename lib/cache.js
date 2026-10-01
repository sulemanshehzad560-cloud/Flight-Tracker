// Tiny TTL cache with request de-duplication: concurrent callers for the same key share one fetch.

export class TtlCache {
  constructor({ maxEntries = 2000 } = {}) {
    this.maxEntries = maxEntries;
    this.entries = new Map(); // key -> { value, expires }
    this.pending = new Map(); // key -> Promise
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expires < Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value, ttlMs) {
    if (this.entries.size >= this.maxEntries) {
      // Map keeps insertion order, so the first key is the oldest.
      this.entries.delete(this.entries.keys().next().value);
    }
    this.entries.set(key, { value, expires: Date.now() + ttlMs });
  }

  /** Returns the cached value, or runs `load()` once (even for concurrent callers) and caches it. */
  async wrap(key, ttlMs, load) {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    if (this.pending.has(key)) return this.pending.get(key);
    const promise = (async () => {
      try {
        const value = await load();
        const ttl = typeof ttlMs === 'function' ? ttlMs(value) : ttlMs;
        if (ttl > 0) this.set(key, value, ttl);
        return value;
      } finally {
        this.pending.delete(key);
      }
    })();
    this.pending.set(key, promise);
    return promise;
  }
}
