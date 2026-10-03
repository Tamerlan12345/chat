# CentyChat Mobile Release Sign-Off

**Decision date:** 2026-10-01
**Status:** **BLOCKED - DO NOT RELEASE**

This document is an evidence ledger, not a claim that either application has
been published, accepted by a store, or a declaration of shipment eligibility.
A status can move
only when every required record below names an immutable artifact and its
execution result.

## Current evidence boundary

| Gate | Evidence currently attached to this report | Decision |
|---|---|---|
| Android automated build, unit tests and lint | No run URL, commit SHA, artifact checksum, or full result attached here. | PENDING |
| Android physical-device validation | No device session record attached. | PENDING |
| macOS/Xcode simulator validation | macOS/Xcode simulator validation: PENDING | BLOCKED |
| iOS physical-device validation | iOS physical-device validation: PENDING | BLOCKED |
| Cross-platform feature parity | No executed parity matrix with iOS runtime evidence is attached. | UNVERIFIED |
| Store submission metadata and reviewer access | Store-console records, privacy answers, test account and review notes are not attached. | PENDING |

Windows can review source and run Android tooling, but it cannot produce the
macOS/Xcode evidence required for iOS simulator builds or signing. A 2014
MacBook Air must also be checked against the Xcode version and iOS deployment
target before it is used as a release-validation host.

## Required evidence for a sign-off

1. Attach the exact Git commit SHA, version/build number, command, timestamp,
   exit code and CI/job URL for every automated gate.
2. Attach immutable build outputs with SHA-256 and identify whether each is a
   debug, unsigned release, signed internal-test, or signed store candidate.
3. Record Android physical-device evidence and iOS simulator and physical iOS
   evidence for the same candidate build.
4. Execute the parity cases in
   [`../test-scenarios/e2e-matrix.md`](../test-scenarios/e2e-matrix.md) on both
   platforms; each row needs a result and a link to logs, screenshots, video
   or a device-farm session.
5. Resolve or explicitly accept every failure with an owner, issue link and
   risk decision. A failed, skipped, or missing case prevents sign-off unless
   release management records an exception.
6. Complete the store-specific handoff in
   [`device-farm-handoff.md`](device-farm-handoff.md), including reviewer
   credentials and final privacy/data-safety answers.

## Sign-off record template

Do not replace this template with a narrative summary.

| Field | Required value |
|---|---|
| Candidate | Version/build number and Git commit SHA |
| Artifact | File name, package/bundle identifier, SHA-256 and signing class |
| Automated evidence | Command, CI URL, timestamp, exit code and report/artifact URL |
| Runtime evidence | Device model, OS, provider/session URL, scenario IDs and result |
| Parity evidence | iOS and Android result for every executed scenario; differences linked to issues |
| Store evidence | App Store Connect / Play Console draft URL or record ID, reviewer account and privacy/data-safety revision |
| Exceptions | Owner, approval authority, expiry date and issue link |
| Release approvers | Named engineering, QA and product approvers with date |

## Release decision rule

Release management may lift the block only after all required fields above have
concrete evidence and the consistency check passes. Until then, the status
remains **BLOCKED - DO NOT RELEASE**.
