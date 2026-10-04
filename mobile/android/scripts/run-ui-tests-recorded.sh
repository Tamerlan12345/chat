#!/usr/bin/env bash
# Runs the instrumented tests on the booted emulator and records the screen in segments of
# <= 170 s (adb screenrecord stops at 180 s). Segments land in mobile/android/build/video/.
# Used by .github/workflows/mobile-android.yml (android-emulator-tests); needs a running emulator.
set -u
out="mobile/android/build/video"
mkdir -p "$out"
stop_file="$(mktemp)"

record_loop() {
  local i=0
  while [ -f "$stop_file" ]; do
    adb shell screenrecord --time-limit 170 --bit-rate 2000000 "/sdcard/seg$(printf '%02d' "$i").mp4" || true
    i=$((i + 1))
  done
}

record_loop &
loop_pid=$!
sleep 2

chmod +x mobile/android/gradlew
mobile/android/gradlew -p mobile/android --no-daemon connectedDebugAndroidTest
status=$?

# Stop recording cleanly: SIGINT makes screenrecord finalise the mp4.
rm -f "$stop_file"
adb shell pkill -2 screenrecord || true
wait "$loop_pid" 2>/dev/null || true
sleep 2
for f in $(adb shell ls /sdcard/seg*.mp4 2>/dev/null | tr -d '\r'); do
  adb pull "$f" "$out/" || true
done
ls -l "$out" || true
exit "$status"
