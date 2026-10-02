# Product

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

One product, three clients: Electron desktop (reference), native iOS (SwiftUI, Apple HIG) and native Android (Jetpack Compose, Material 3). Mobile clients share business logic and brand, but each follows its own OS design language.

## Users

All company employees. Desktop is the primary workplace; the mobile apps are its companion — used so nothing is missed away from the PC: reading and answering colleagues, seeing official announcements, taking a voice call, being "woken" by a colleague.

## Product Purpose

CentyChat is the company's internal messenger. It replaces public messengers for work communication so that correspondence, calls and files stay inside the company perimeter. Success: employees reach each other reliably from desk or phone, and no message is silently lost.

## Positioning

Self-hosted: the company runs its own server, data never leaves the internal perimeter, and calls and chats work without external services — something Telegram, WhatsApp or Teams cannot truthfully offer this company.

## Operating Context

- Server address is configured per installation (onboarding starts with "server setup"), then login; devices can pair for passwordless re-entry (knock/claim).
- Direct chats and channels; official announcements with "Ознакомлен" acknowledgement and audit; colleague "wake" (побудка); 1:1 voice calls over the server's audio relay; attachments governed by an admin file policy; presence (online/away/DND) and custom status; org structure on desktop.
- Role-based permissions (calls, channel creation, broadcasting) come from the server.

## Capabilities and Constraints

- Russian-only UI copy.
- Release builds talk to the server only over HTTPS/WSS; credentials are stored in Keychain / Android Keystore and fail closed.
- Distribution is corporate (TestFlight / Apple Business Manager, Managed Google Play), not public stores.
- No push notifications yet (server work planned); remote desktop is desktop-only.

## Brand Commitments

- Must match the desktop identity: the "C" mark, brand gradient `#ec8ee0 → #c078ee → #7c44ea → #2a72ee → #00daff`, violet primary (`#5b4ee6` light / `#6457ee` dark), status colours online `#2da44e`, away `#d4951c`, dnd `#d9363b`. Tokens live in `desktop/src/renderer/src/styles/theme.css`.
- Owner feedback (2026-10-01/02): previous mobile design was "ужасный"; mobile must be visibly closer to desktop and feel smoother, with better motion and animation.

## Evidence on Hand

- Desktop app (`desktop/src/renderer`) is the visual and functional reference.
- App icon: `mobile/ios/CentyChat/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png` (C mark).
- No user research, metrics or testimonials exist; do not fabricate them.

## Product Principles

1. Never lose a message: every send is visibly queued, sent, delivered or failed — never silently dropped.
2. Same product everywhere: identical behaviour and vocabulary on desktop, iOS and Android; native look per platform.
3. Inside the perimeter: no feature may depend on an external service.
4. Calm, fast, fluid: work tool first — scannable, quiet, with smooth purposeful motion rather than decoration.

## Accessibility & Inclusion

Standard platform accessibility: Dynamic Type / font scale, VoiceOver / TalkBack, 44pt / 48dp targets, contrast in light and dark themes (desktop switches theme by time of day).
