// Android app only: a fetch() replacement that performs requests in native code through the
// `NativeHttp` bridge (see android/src/.../MainActivity.java). WebView's own fetch can't read the
// flight-data APIs because they don't send CORS headers; native HTTP isn't subject to CORS.

const pending = new Map();
let nextId = 1;

window.__nativeHttpDone = (id, status, headersJson, body, error) => {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  if (error) {
    p.reject(new TypeError(`Network request failed: ${error}`));
    return;
  }
  let headers = {};
  try {
    headers = JSON.parse(headersJson);
  } catch {
    // malformed headers – leave empty
  }
  p.resolve({
    ok: status >= 200 && status < 300,
    status,
    url: p.url,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    text: async () => body,
    json: async () => JSON.parse(body),
  });
};

export function nativeFetch(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const id = String(nextId++);
    const plain = headers instanceof Headers ? Object.fromEntries(headers) : { ...headers };
    pending.set(id, { resolve, reject, url: String(url) });
    window.NativeHttp.request(id, method, String(url), JSON.stringify(plain), body == null ? '' : String(body));
  });
}

export const isNativeApp = () => typeof window.NativeHttp !== 'undefined';
