#!/usr/bin/env python3
"""Export PNG screenshot attachments from an .xcresult bundle.

Files are named "<TestClass>-<testMethod>--<attachment name>.png" so that the
test and the appearance (light/dark suffix in the attachment name) are visible
in the file name.

Xcode 16+ exposes `xcresulttool export attachments`; older toolchains only have
the legacy object graph API, which is used as a fallback.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

SAFE = re.compile(r"[^A-Za-z0-9._-]+")
SUGGESTED_SUFFIX = re.compile(r"_\d+_[0-9A-Fa-f-]{36}(\.[A-Za-z0-9]+)$")


def sanitize(value: str) -> str:
    return SAFE.sub("-", value).strip("-") or "unnamed"


def test_label(identifier: str) -> str:
    # "ScreenshotTourTests/testServerSetupTourInLightAppearance()" -> "ScreenshotTourTests-testServerSetupTourInLightAppearance"
    return sanitize(identifier.replace("()", "").replace("/", "-"))


def attachment_label(name: str) -> str:
    base = SUGGESTED_SUFFIX.sub(r"\1", name)
    base, _ = os.path.splitext(base)
    return sanitize(base)


def unique_path(directory: str, file_name: str) -> str:
    candidate = os.path.join(directory, file_name)
    stem, ext = os.path.splitext(file_name)
    index = 2
    while os.path.exists(candidate):
        candidate = os.path.join(directory, f"{stem}-{index}{ext}")
        index += 1
    return candidate


def export_modern(result_path: str, output_dir: str) -> int:
    staging = tempfile.mkdtemp(prefix="xcresult-attachments-")
    subprocess.run(
        ["xcrun", "xcresulttool", "export", "attachments", "--path", result_path, "--output-path", staging],
        check=True,
    )
    with open(os.path.join(staging, "manifest.json"), encoding="utf-8") as manifest_file:
        manifest = json.load(manifest_file)

    exported = 0
    for test in manifest:
        label = test_label(test.get("testIdentifier", "unknown"))
        for attachment in test.get("attachments", []):
            source = os.path.join(staging, attachment["exportedFileName"])
            if not source.lower().endswith(".png") or not os.path.exists(source):
                continue
            name = attachment.get("suggestedHumanReadableName") or attachment["exportedFileName"]
            target = unique_path(output_dir, f"{label}--{attachment_label(name)}.png")
            shutil.copyfile(source, target)
            exported += 1
    return exported


def legacy_get(result_path: str, object_id: str | None = None) -> dict:
    command = ["xcrun", "xcresulttool", "get", "--legacy", "--format", "json", "--path", result_path]
    if object_id:
        command += ["--id", object_id]
    completed = subprocess.run(command, check=True, capture_output=True, text=True)
    return json.loads(completed.stdout)


def values(node: dict, key: str) -> list:
    return node.get(key, {}).get("_values", [])


def string_value(node: dict, key: str) -> str:
    return node.get(key, {}).get("_value", "")


def walk_tests(node: dict):
    for subtest in values(node, "subtests"):
        if string_value(subtest, "summaryRef") or subtest.get("summaryRef"):
            yield subtest
        yield from walk_tests(subtest)


def walk_activities(activities: list):
    for activity in activities:
        yield activity
        yield from walk_activities(values(activity, "subactivities"))


def export_legacy(result_path: str, output_dir: str) -> int:
    root = legacy_get(result_path)
    exported = 0
    for action in values(root, "actions"):
        tests_ref = action.get("actionResult", {}).get("testsRef", {}).get("id", {}).get("_value")
        if not tests_ref:
            continue
        plan_summaries = legacy_get(result_path, tests_ref)
        for summary in values(plan_summaries, "summaries"):
            for testable in values(summary, "testableSummaries"):
                for group in values(testable, "tests"):
                    for test in walk_tests(group):
                        summary_id = test.get("summaryRef", {}).get("id", {}).get("_value")
                        if not summary_id:
                            continue
                        label = test_label(string_value(test, "identifier"))
                        detail = legacy_get(result_path, summary_id)
                        for activity in walk_activities(values(detail, "activitySummaries")):
                            for attachment in values(activity, "attachments"):
                                if string_value(attachment, "uniformTypeIdentifier") != "public.png":
                                    continue
                                payload_id = attachment.get("payloadRef", {}).get("id", {}).get("_value")
                                if not payload_id:
                                    continue
                                name = string_value(attachment, "name") or string_value(attachment, "filename")
                                target = unique_path(output_dir, f"{label}--{attachment_label(name)}.png")
                                subprocess.run(
                                    [
                                        "xcrun", "xcresulttool", "export", "--legacy", "--type", "file",
                                        "--path", result_path, "--id", payload_id, "--output-path", target,
                                    ],
                                    check=True,
                                )
                                exported += 1
    return exported


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: export-xcresult-screenshots.py <bundle.xcresult> <output-dir>", file=sys.stderr)
        return 2
    result_path, output_dir = sys.argv[1], sys.argv[2]
    if not os.path.isdir(result_path):
        print(f"No result bundle at {result_path}; nothing to export.")
        return 0
    os.makedirs(output_dir, exist_ok=True)
    try:
        exported = export_modern(result_path, output_dir)
    except (subprocess.CalledProcessError, FileNotFoundError, KeyError, json.JSONDecodeError) as error:
        print(f"Modern attachment export unavailable ({error}); using the legacy API.")
        exported = export_legacy(result_path, output_dir)
    print(f"Exported {exported} screenshot(s) to {output_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
