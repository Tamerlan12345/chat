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
    adb shell screenrecord --time-limit 170 --size 540x1200 --bit-rate 1000000 "/data/local/tmp/seg$(printf '%02d' "$i").mp4" || sleep 5
    i=$((i + 1))
  done
}

chmod +x mobile/android/gradlew
# Build first so the recording covers only the test run, not the Gradle build.
mobile/android/gradlew -p mobile/android --no-daemon assembleDebug assembleDebugAndroidTest || exit 1

# Keep the emulator quiet: no ANR/system dialogs stealing window focus from the tests.
adb shell settings put secure anr_show_background 0 || true
adb shell settings put global hide_error_dialogs 1 || true
adb shell input keyevent 82 || true
adb shell am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS > /dev/null || true

record_loop &
loop_pid=$!
sleep 2

mobile/android/gradlew -p mobile/android --no-daemon connectedDebugAndroidTest
status=$?

# Stop recording cleanly: SIGINT makes screenrecord finalise the mp4.
rm -f "$stop_file"
adb shell pkill -2 screenrecord || true
wait "$loop_pid" 2>/dev/null || true
sleep 2
for f in $(adb shell ls /data/local/tmp/seg*.mp4 2>/dev/null | tr -d '\r'); do
  adb pull "$f" "$out/" || true
done
ls -l "$out" || true
# Artifacts cannot always be downloaded: name each failing test and its first lines in the log.
if [ "$status" -ne 0 ]; then
  # Per-device result files may sit in subfolders: find them all.
  find mobile/android/app/build/outputs/androidTest-results -name '*.xml' 2>/dev/null | while read -r xml; do
    python3 - "$xml" <<'PY' || true
import sys, xml.etree.ElementTree as ET
for case in ET.parse(sys.argv[1]).getroot().iter('testcase'):
    for failure in list(case.findall('failure')) + list(case.findall('error')):
        print(f"FAILED {case.get('classname')}.{case.get('name')}")
        print('\n'.join((failure.text or '').strip().splitlines()[:12]))
PY
  done
fi
exit "$status"
