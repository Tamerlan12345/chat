#!/usr/bin/env python3
"""Prints the UDID of the named simulator on the newest installed iOS runtime.

usage: xcrun simctl list devices available --json | pick-simulator.py "iPhone 16"
"""

import json
import sys


def runtime_version(runtime: str) -> tuple[int, ...]:
    return tuple(int(part) for part in runtime.rsplit("iOS-", 1)[1].split("-"))


def main() -> int:
    name = sys.argv[1] if len(sys.argv) > 1 else "iPhone 16"
    devices = json.load(sys.stdin)["devices"]
    candidates = [
        (runtime_version(runtime), device["udid"])
        for runtime, items in devices.items()
        if "iOS-" in runtime
        for device in items
        if device.get("name") == name and device.get("isAvailable", True)
    ]
    if not candidates:
        print(f"No available simulator named {name!r}", file=sys.stderr)
        return 1
    print(max(candidates)[1])
    return 0


if __name__ == "__main__":
    sys.exit(main())
