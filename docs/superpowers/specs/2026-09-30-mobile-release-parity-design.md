# Mobile release parity: design

## Goal

Turn the existing CentyChat iOS and Android source trees into secure, reproducibly buildable native clients with the same documented business behaviour. The release is accepted only when the platforms use the shared contracts, pass their automated suites, and have a documented path for device-farm testing.

## Non-negotiable invariants

- Release builds only send credentials, chat content and audio over HTTPS/WSS. Development-only local endpoints are explicit build configuration, never a release default.
- Tokens and device secrets never fall back to plaintext storage and never enter Android backup or device-transfer payloads.
- A server is configured only after URL validation and a successful connectivity check. A failed connection must leave a recoverable setup screen.
- A local message is cleared from the composer only after it is queued durably or accepted for delivery. Reconnect must replay queued work without duplicating it.
- The OpenAPI and WebSocket contracts in `mobile/contracts` are the source of truth. Platform code may differ, observable behaviour may not.
- iOS follows SwiftUI/HIG; Android follows Material 3, edge-to-edge and adaptive navigation guidance.

## Phase 1: build and release foundation

### iOS packaging and CI

Create a signed-app-ready Xcode project/workspace with an iOS application target, test targets, assets, entitlement configuration and a shared test scheme. Keep reusable domain/network code in a package/module when practical, but do not make the executable app depend on a library target with an `@main` entry point. Remove the unsupported macOS platform declaration unless a separately tested macOS target is intentionally added.

Add a GitHub Actions macOS workflow that resolves dependencies, builds the iOS scheme, runs XCTest on a named iOS Simulator and uploads logs/results. Secrets for signing and TestFlight are out of scope until a release owner supplies an Apple Developer Team; unsigned simulator CI must work without them.

### Android reproducibility

Commit the Gradle Wrapper and define deterministic unit-test, lint and debug-build commands. Configure release minification and a release signing input contract without committing signing material. Add CI that runs unit tests and lint/build where the runner has Android SDK access.

### Transport, session and onboarding

Both platforms validate an HTTPS server base URL in release mode, derive WSS only from HTTPS, and reject unsupported schemes before storage. Debug endpoints are build-time injected and must not be available from a release configuration.

Android removes global cleartext traffic, fails closed if encrypted storage cannot be opened, and excludes the actual encrypted-session names from cloud backup and device transfer. iOS stores credentials using a `ThisDeviceOnly` Keychain accessibility class consistent with required background behaviour.

Both apps start at server setup on a fresh installation, retain only a verified endpoint, serialize refresh work so concurrent authentication failures cannot log out a valid session, and surface actionable connection/authentication errors.

### Lifecycle, accessibility and core UI repairs

Android uses destination-scoped ViewModels and tab selection that does not append duplicate top-level destinations. It provides adaptive navigation for expanded windows, scroll/IME-safe authentication/setup forms, semantic Material colours and 48dp controls.

iOS removes nested interactive controls in new-chat navigation, provides minimum 44pt hit areas, handles microphone grant/denial/settings recovery, and declares only background modes backed by an implementation.

Both platforms distinguish loading, empty, retryable-error and content states for chats and announcements.

## Phase 2: feature parity and reliable delivery

### Delivery and offline state

Implement a platform-local durable outbox and conversation cache. Define an operation identity/idempotency strategy in the shared contract before implementation. The client marks queued, sending, delivered, read and failed states explicitly; replay runs after reconnect, preserves ordering per conversation and exposes retry/cancel rather than silently discarding text.

Wire all documented WebSocket message, edit, delete, read and delivery events into the visible conversation state. Add deterministic tests for the token-refresh and reconnect races.

### Files, conversations and audio

Apply file policy before selection/upload, implement upload progress and failure recovery, and provide safe download/open handling for supported images/PDFs on both platforms. Android gains the documented create-channel and create-direct-conversation flows.

Implement the documented 16 kHz PCM audio relay on iOS: microphone capture, permission gate, WebSocket frame transmission, jitter-buffered playback, lifecycle teardown and state transitions. Android and iOS call semantics, error states and permission recovery must match the contracts.

## Tests and acceptance evidence

Each behaviour change is introduced by a failing test, then implemented minimally, then verified by the complete available suite. Required test layers are:

- unit tests for URL policy, secure storage failure, backup rule identity, refresh serialization, outbox transitions, message windows and audio buffering;
- platform UI tests for onboarding, permission denial, loading/error/empty states, tab/back navigation, chat retry and primary accessibility labels;
- contract fixtures shared between platforms for DTO and WebSocket decoding;
- CI evidence for iOS Simulator XCTest and Android unit/lint/debug build;
- a BrowserStack/App Automate-ready IPA upload and test-command handoff after iOS signing is supplied.

Physical-device checks remain mandatory before store submission: microphone denial/grant, notification behaviour, reconnect/offline replay, real audio call, dynamic type/font scale, screen rotation, TalkBack/VoiceOver and release network TLS.

## Delivery order

1. Establish source control/build entry points and CI baselines.
2. Make transport, credential persistence and server onboarding safe.
3. Repair lifecycle, navigation, state/error presentation and platform accessibility gaps.
4. Add reliable offline delivery and realtime message state.
5. Complete file/conversation/audio parity.
6. Run code review, CI and release-readiness evidence collection.

## Out of scope

- Publishing to App Store/Google Play, pushing branches, creating a GitHub repository, adding paid device-farm accounts, or configuring Apple signing secrets.
- Replacing product copy or visual identity except where required for an error, permission, accessibility or platform-native control.
