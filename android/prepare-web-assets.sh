#!/usr/bin/env bash
# Copies the web app (public/ + lib/) and the MapLibre library into an Android assets folder.
# Called by Gradle before every build: prepare-web-assets.sh <output-dir>
set -euo pipefail
OUT="$1"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MAPLIBRE_VERSION="5.6.0"

rm -rf "$OUT"
mkdir -p "$OUT/www/vendor"
cp -r "$ROOT/public" "$OUT/www/public"
cp -r "$ROOT/lib" "$OUT/www/lib"
rm -f "$OUT/www/lib/demo.js"   # simulated traffic is for development only

# Bundle the map library so the app starts without a CDN.
TMP="$(mktemp -d)"
(cd "$TMP" && npm pack --silent "maplibre-gl@$MAPLIBRE_VERSION" >/dev/null && tar -xzf maplibre-gl-*.tgz)
cp "$TMP/package/dist/maplibre-gl.js" "$TMP/package/dist/maplibre-gl.css" "$OUT/www/vendor/"
rm -rf "$TMP"
sed -i.bak "s#https://unpkg.com/maplibre-gl@[0-9.]*/dist/#../vendor/#g" "$OUT/www/public/index.html"
rm -f "$OUT/www/public/index.html.bak"
grep -q '../vendor/maplibre-gl.js' "$OUT/www/public/index.html"
