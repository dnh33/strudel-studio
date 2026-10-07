#!/usr/bin/env bash
# Runs the native app end-to-end test on Linux (headless):
#   Xvfb (display) + JACK with the dummy driver (audio device) + the example VST3 plug-ins,
#   then the app runs tests/native-e2e.js inside its WebView and exits with the result.
#
#   native/build must contain a Release build (cmake -S native -B native/build -G Ninja -DJUCE_DIR=... ).
#   Screenshots and logs go to $OUT (default /tmp/strudel-native-test).
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
BUILD=${BUILD:-$ROOT/native/build}
APP="$BUILD/StrudelStudio_artefacts/Release/Strudel Studio"
OUT=${OUT:-/tmp/strudel-native-test}
DISP=${DISP:-:97}
TIMEOUT=${TIMEOUT:-300}
mkdir -p "$OUT"
rm -f "$OUT"/*.png "$OUT"/app.log

cleanup() {
  [ -n "${APID:-}" ] && kill "$APID" 2>/dev/null
  [ -n "${JPID:-}" ] && kill "$JPID" 2>/dev/null
  [ -n "${XPID:-}" ] && kill "$XPID" 2>/dev/null
  [ -n "${HPID:-}" ] && kill "$HPID" 2>/dev/null
  command -v pulseaudio >/dev/null && pulseaudio --kill >/dev/null 2>&1
}
trap cleanup EXIT

export DISPLAY=$DISP
Xvfb "$DISP" -screen 0 1600x1000x24 >/dev/null 2>&1 &
XPID=$!
jackd --no-realtime -d dummy -r 48000 -p 256 >"$OUT/jack.log" 2>&1 &
JPID=$!
# PulseAudio with a null sink gives the WebView (WebKitGTK) an audio output, so Web Audio works too
if command -v pulseaudio >/dev/null; then
  pulseaudio --kill >/dev/null 2>&1
  pulseaudio -D --exit-idle-time=-1 --disallow-exit >/dev/null 2>&1
  sleep 1
  pactl load-module module-null-sink sink_name=studio_null >/dev/null 2>&1
  pactl set-default-sink studio_null >/dev/null 2>&1
fi
sleep 2

# audio device: JACK
CFG=${XDG_CONFIG_HOME:-$HOME/.config}/StrudelStudio
mkdir -p "$CFG"
cat >"$CFG/audio-device.xml" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<DEVICESETUP deviceType="JACK" audioOutputDeviceName="system" audioInputDeviceName="system"
             audioDeviceRate="48000.0" audioDeviceBufferSize="256"/>
EOF
rm -f "$CFG/plugins.xml" "$CFG/session.json"

# example plug-ins next to the program (the app scans a "VST3" folder beside/above its executable)
PLUG="$BUILD/VST3"
mkdir -p "$PLUG"
for p in "Strudel Test Synth" "Strudel Test Drive"; do
  src=$(find "$BUILD" -type d -name "$p.vst3" -path "*VST3*" | head -1)
  [ -n "$src" ] && rm -rf "$PLUG/$p.vst3" && cp -r "$src" "$PLUG/"
done
ls "$PLUG"

export STRUDEL_STUDIO_TEST_SCRIPT="$ROOT/tests/native-e2e.js"
if [ "${USE_HTTP:-1}" = "1" ]; then
  # WebKitGTK treats http://localhost as a secure context (AudioWorklet etc.); juce:// isn't
  (cd "$ROOT/app" && python3 -m http.server 8765 --bind 127.0.0.1 >/dev/null 2>&1) &
  HPID=$!
  export STRUDEL_STUDIO_DEV_URL="http://127.0.0.1:8765/"
  sleep 1
else
  export STRUDEL_STUDIO_WEB_ROOT="$ROOT/app"
fi

"$APP" >"$OUT/app.log" 2>&1 &
APID=$!

shot=0
start=$(date +%s)
while kill -0 "$APID" 2>/dev/null; do
  sleep 0.5
  # take screenshots when the test asks for them
  while read -r name; do
    [ -z "$name" ] && continue
    import -window root "$OUT/$name.png" 2>/dev/null && echo "screenshot $OUT/$name.png"
  done < <(grep -o "SCREENSHOT [a-z0-9_-]*" "$OUT/app.log" | awk '{print $2}' | tail -n +$((shot + 1)))
  shot=$(grep -c "SCREENSHOT " "$OUT/app.log")
  if [ $(($(date +%s) - start)) -gt "$TIMEOUT" ]; then
    echo "TIMEOUT"
    import -window root "$OUT/timeout.png" 2>/dev/null
    kill "$APID" 2>/dev/null
    sleep 2
    kill -9 "$APID" 2>/dev/null
    break
  fi
done
wait "$APID" 2>/dev/null
code=$?
grep "^\[test\]" "$OUT/app.log"
echo "app exit code: $code"
exit $code
