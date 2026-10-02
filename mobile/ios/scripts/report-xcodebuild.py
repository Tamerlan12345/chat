#!/usr/bin/env python3
"""Turns an xcodebuild log (and, if present, its .xcresult) into readable CI output.

Usage: report-xcodebuild.py <log> [<xcresult>] [<title>]

- Compiler errors and failing XCTest assertions become `::error file=…,line=…` annotations
  (readable without auth through the check-run annotations API);
- the job summary gets the test counts, the failing tests and the error lines;
- the same facts are printed to the log.
Never fails the step itself: the build/test step already carries the verdict.
"""
import json
import os
import re
import subprocess
import sys

log_path = sys.argv[1]
xcresult = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else None
title = sys.argv[3] if len(sys.argv) > 3 else "xcodebuild"
workspace = os.environ.get("GITHUB_WORKSPACE", "")

COMPILER = re.compile(r"^(/[^:]+):(\d+):(?:(\d+):)? (error|fatal error): (.*)$")
XCTEST = re.compile(r"^(/[^:]+):(\d+): error: -\[(\S+) (\S+)\] : (.*)$")
CASE_FAILED = re.compile(r"Test [Cc]ase '-?\[?([^\]']+?)\]?' failed")
EXECUTED = re.compile(r"Executed (\d+) tests?, with (\d+) failures? \((\d+) unexpected\)")
GENERIC = re.compile(r"^(error: .*|ld: .*|clang: error: .*|\*\* (BUILD|TEST|ARCHIVE) FAILED \*\*.*)$")


def rel(path):
    if workspace and path.startswith(workspace + "/"):
        return path[len(workspace) + 1:]
    return path


def esc(text):
    return text.replace("%", "%25").replace("\r", "").replace("\n", "%0A")


try:
    with open(log_path, encoding="utf-8", errors="replace") as handle:
        lines = [line.rstrip("\n") for line in handle]
except OSError as error:
    print(f"::warning title={title}::no log at {log_path}: {error}")
    sys.exit(0)

compiler, assertions, generic, failed_cases, executed = [], [], [], [], []
seen = set()
for line in lines:
    m = XCTEST.match(line)
    if m:
        key = ("t", m.group(1), m.group(2), m.group(5))
        if key not in seen:
            seen.add(key)
            assertions.append((rel(m.group(1)), m.group(2), f"{m.group(3)}.{m.group(4)}", m.group(5)))
        continue
    m = COMPILER.match(line)
    if m:
        key = ("c", m.group(1), m.group(2), m.group(5))
        if key not in seen:
            seen.add(key)
            compiler.append((rel(m.group(1)), m.group(2), m.group(3) or "1", m.group(5)))
        continue
    m = GENERIC.match(line.strip())
    if m and line.strip() not in seen:
        seen.add(line.strip())
        generic.append(line.strip())
    m = CASE_FAILED.search(line)
    if m and m.group(1) not in failed_cases:
        failed_cases.append(m.group(1))
    m = EXECUTED.search(line)
    if m:
        executed.append(m.group(0))

# Test counts from the result bundle (Xcode 16+), when there is one.
summary = None
if xcresult and os.path.isdir(xcresult):
    try:
        out = subprocess.run(
            ["xcrun", "xcresulttool", "get", "test-results", "summary", "--path", xcresult],
            capture_output=True, text=True, timeout=120,
        )
        if out.returncode == 0:
            summary = json.loads(out.stdout)
    except Exception as error:  # noqa: BLE001 - reporting must never fail the job
        print(f"xcresulttool failed: {error}")

counts = ""
if summary:
    counts = (
        f"total {summary.get('totalTestCount')}, passed {summary.get('passedTests')}, "
        f"failed {summary.get('failedTests')}, skipped {summary.get('skippedTests')}, "
        f"result {summary.get('result')}"
    )
    for failure in summary.get("testFailures", []) or []:
        name = f"{failure.get('targetName', '')}/{failure.get('testIdentifierString', failure.get('testName', ''))}"
        if name not in failed_cases:
            failed_cases.append(name)
        text = failure.get("failureText", "")
        if not any(a[2] in name and a[3] == text for a in assertions):
            assertions.append(("", "", name, text))

# Annotations: GitHub keeps 10 errors per step, so the first ones go one by one and the rest in one block.
budget = 9
for path, line, col, message in compiler:
    if budget == 0:
        break
    print(f"::error file={path},line={line},col={col},title=compile::{esc(message)}")
    budget -= 1
for path, line, test, message in assertions:
    if budget == 0:
        break
    location = f"file={path},line={line}," if path else ""
    print(f"::error {location}title={esc(test)}::{esc(message)}")
    budget -= 1

block = []
block += [f"{p}:{l}: {m}" for p, l, _, m in compiler]
block += [f"{t} @ {p}:{l}: {m}" for p, l, t, m in assertions]
block += [f"FAILED {c}" for c in failed_cases]
block += generic
if counts:
    block.append(f"counts: {counts}")
block += executed
if block:
    print(f"::warning title={title} report::{esc(chr(10).join(block[:150]))}")
else:
    print(f"::notice title={title} report::no errors found in the log")
if counts:
    print(f"::notice title={title} counts::{esc(counts)}")
elif executed:
    print(f"::notice title={title} counts::{esc('; '.join(executed))}")

print("==== report ====")
print("\n".join(block) if block else "no errors found")

summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
if summary_path:
    with open(summary_path, "a", encoding="utf-8") as out:
        out.write(f"## {title}\n\n")
        if counts:
            out.write(f"**Tests:** {counts}\n\n")
        for item in executed:
            out.write(f"- {item}\n")
        if failed_cases:
            out.write("\n### Failing tests\n\n")
            for case in failed_cases:
                out.write(f"- `{case}`\n")
        if compiler or assertions or generic:
            out.write("\n### Errors\n\n```\n")
            out.write("\n".join(block[:300]))
            out.write("\n```\n")
