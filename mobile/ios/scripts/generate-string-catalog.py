#!/usr/bin/env python3
"""Adds every user-facing string literal of the app sources to Localizable.xcstrings.

Xcode extracts SwiftUI and String(localized:) keys automatically when it builds
with SWIFT_EMIT_LOC_STRINGS; this script keeps the checked-in catalog complete
for machines without Xcode. Interpolations become format specifiers the same
way the compiler builds the key (Int-like values -> %lld, everything else -> %@).
Existing entries and translations are preserved; nothing is removed.

usage: generate-string-catalog.py [--check]
"""

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCES = os.path.join(HERE, "..", "CentyChat")
CATALOG = os.path.join(SOURCES, "Resources", "Localizable.xcstrings")

CYRILLIC = re.compile(r"[А-Яа-яЁё]")
INTEGER_HINTS = re.compile(r"(count|Count|Unread|Remaining|statusCode|seconds|minutes)\b")
# Latin-only literals that are still user-facing (none at the moment).
EXTRA_KEYS: list[str] = []


def interpolation_specifier(expression: str) -> str:
    return "%lld" if INTEGER_HINTS.search(expression) else "%@"


def scan_literals(source: str):
    """Yields (key, raw) for every single-line string literal outside comments."""
    i, n = 0, len(source)
    while i < n:
        if source.startswith("//", i):
            i = source.find("\n", i)
            if i < 0:
                return
            continue
        if source.startswith("/*", i):
            end = source.find("*/", i + 2)
            i = n if end < 0 else end + 2
            continue
        if source.startswith('"""', i):
            end = source.find('"""', i + 3)
            i = n if end < 0 else end + 3
            continue
        if source[i] == '"':
            key, i = read_literal(source, i + 1)
            if key is not None:
                yield key
            continue
        i += 1


def read_literal(source: str, i: int):
    out = []
    n = len(source)
    while i < n:
        c = source[i]
        if c == '"':
            return "".join(out), i + 1
        if c == "\n":
            return None, i
        if c == "\\":
            nxt = source[i + 1]
            if nxt == "(":
                expression, i = read_interpolation(source, i + 2)
                out.append(interpolation_specifier(expression))
                continue
            out.append({"n": "\n", "t": "\t", '"': '"', "\\": "\\", "'": "'", "0": "\0"}.get(nxt, nxt))
            i += 2
            continue
        out.append(c)
        i += 1
    return None, i


def read_interpolation(source: str, i: int):
    depth, start = 1, i
    while i < len(source):
        c = source[i]
        if c == '"':
            _, i = read_literal(source, i + 1)
            continue
        if c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
            if depth == 0:
                return source[start:i], i + 1
        i += 1
    return source[start:], i


def collect_keys():
    keys = set(EXTRA_KEYS)
    for directory, _, files in os.walk(SOURCES):
        for name in files:
            if not name.endswith(".swift"):
                continue
            with open(os.path.join(directory, name), encoding="utf-8") as handle:
                for key in scan_literals(handle.read()):
                    if CYRILLIC.search(key):
                        keys.add(key)
    return keys


def main() -> int:
    check_only = "--check" in sys.argv
    if os.path.exists(CATALOG):
        with open(CATALOG, encoding="utf-8") as handle:
            catalog = json.load(handle)
    else:
        catalog = {"sourceLanguage": "ru", "strings": {}, "version": "1.0"}

    strings = catalog["strings"]
    missing = sorted(collect_keys() - set(strings))
    if check_only:
        for key in missing:
            print(f"missing: {key!r}")
        return 1 if missing else 0

    for key in missing:
        strings[key] = {
            "extractionState": "manual",
            "localizations": {"ru": {"stringUnit": {"state": "translated", "value": key}}},
        }
    catalog["strings"] = dict(sorted(strings.items()))
    with open(CATALOG, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(catalog, handle, ensure_ascii=False, indent=2, separators=(",", " : "))
        handle.write("\n")
    print(f"{len(missing)} key(s) added, {len(strings)} total")
    return 0


if __name__ == "__main__":
    sys.exit(main())
