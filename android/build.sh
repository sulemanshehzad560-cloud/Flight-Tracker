#!/usr/bin/env bash
# Builds android/build/FlightTracker.apk without Gradle: aapt2 → javac → dx → zipalign → apksigner.
#
# Needs a JDK (11+), plus an Android platform (android.jar) and build tools. On Ubuntu/Debian:
#   sudo apt install android-sdk-platform-23 android-sdk-build-tools dalvik-exchange
# With a regular Android SDK, set ANDROID_JAR and BUILD_TOOLS instead (DX=$BUILD_TOOLS/d8 is not
# supported; install dalvik-exchange or point DX at a dx script).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
OUT="$HERE/build"
ANDROID_JAR="${ANDROID_JAR:-/usr/lib/android-sdk/platforms/android-23/android.jar}"
BUILD_TOOLS="${BUILD_TOOLS:-/usr/lib/android-sdk/build-tools/debian}"
AAPT2="${AAPT2:-$BUILD_TOOLS/aapt2}"
ZIPALIGN="${ZIPALIGN:-$(command -v zipalign || echo "$BUILD_TOOLS/zipalign")}"
APKSIGNER="${APKSIGNER:-$(command -v apksigner || echo "$BUILD_TOOLS/apksigner")}"
DX="${DX:-$(command -v dalvik-exchange || command -v dx)}"
MAPLIBRE_VERSION="5.6.0"
KEYSTORE="${KEYSTORE:-$HERE/debug.keystore}"
KEYSTORE_PASS="${KEYSTORE_PASS:-android}"

for tool in "$ANDROID_JAR" "$AAPT2" "$ZIPALIGN" "$APKSIGNER" "$DX"; do
  [ -e "$tool" ] || { echo "Missing: $tool (see the header of this script)" >&2; exit 1; }
done

rm -rf "$OUT"
mkdir -p "$OUT/assets/www/vendor" "$OUT/classes" "$OUT/gen"

echo "• Bundling the web app"
cp -r "$ROOT/public" "$OUT/assets/www/public"
cp -r "$ROOT/lib" "$OUT/assets/www/lib"
# The map library is bundled so the app starts without a CDN.
(cd "$OUT" && npm pack --silent "maplibre-gl@$MAPLIBRE_VERSION" >/dev/null && tar -xzf maplibre-gl-*.tgz \
  package/dist/maplibre-gl.js package/dist/maplibre-gl.css && rm maplibre-gl-*.tgz)
mv "$OUT/package/dist/maplibre-gl.js" "$OUT/package/dist/maplibre-gl.css" "$OUT/assets/www/vendor/"
rm -rf "$OUT/package"
sed -i "s#https://unpkg.com/maplibre-gl@[0-9.]*/dist/#../vendor/#g" "$OUT/assets/www/public/index.html"
grep -q '../vendor/maplibre-gl.js' "$OUT/assets/www/public/index.html"

echo "• Compiling resources"
"$AAPT2" compile --dir "$HERE/res" -o "$OUT/res.zip"
"$AAPT2" link -o "$OUT/base.apk" -I "$ANDROID_JAR" --manifest "$HERE/AndroidManifest.xml" \
  -A "$OUT/assets" --java "$OUT/gen" "$OUT/res.zip"

echo "• Compiling Java"
javac -nowarn -Xlint:-options --release 8 -classpath "$ANDROID_JAR" -d "$OUT/classes" \
  $(find "$HERE/src" "$OUT/gen" -name '*.java')
"$DX" --dex --output="$OUT/classes.dex" "$OUT/classes"

echo "• Packaging and signing"
cp "$OUT/base.apk" "$OUT/unsigned.apk"
(cd "$OUT" && zip -q -j unsigned.apk classes.dex)
"$ZIPALIGN" -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"
if [ ! -f "$KEYSTORE" ]; then
  keytool -genkeypair -keystore "$KEYSTORE" -storepass "$KEYSTORE_PASS" -keypass "$KEYSTORE_PASS" \
    -alias flighttracker -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=Flight Tracker Debug" 2>/dev/null
fi
"$APKSIGNER" sign --ks "$KEYSTORE" --ks-pass "pass:$KEYSTORE_PASS" --out "$OUT/FlightTracker.apk" "$OUT/aligned.apk"
"$APKSIGNER" verify "$OUT/FlightTracker.apk"

echo "✓ $OUT/FlightTracker.apk ($(du -h "$OUT/FlightTracker.apk" | cut -f1))"
