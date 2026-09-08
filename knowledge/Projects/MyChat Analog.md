---
date: 2026-09-04
updated: 2026-09-07
type: project
status: active
tags: [project, mychat, corporate-messenger, lan-chat, webrtc, sqlite]
job: Messenger
repo: c:/Users/user/Documents/Нет в репо/chat
ai-first: true
---

## For future agent
This note documents the OpenMyChat project, a 100% self-hosted corporate messenger analog to MyChat (nsoft-s.com) created on 2026-09-04. It details the system goals, requirements, production architecture without mocks or stubs, integrated Web Database Studio, and lightweight Windows service deployment. As of 2026-09-07 the scope was narrowed to a pure colleague chat: Kanban and Bulletin Board (BBS) were fully removed from schema, API, and UI (see [[Logs/2026-09-07]]) — do not re-introduce them as differentiators without checking current code first.

## Overview
OpenMyChat is an enterprise-grade, on-premise local area network (LAN) and WAN corporate messaging platform designed to provide complete communication autonomy, end-to-end data ownership, and strict corporate hierarchy features modeled after MyChat by Network Software Solutions.

Key differentiators:
- **Zero Cloud Reliance**: Functions in completely isolated air-gapped networks.
- **Hierarchical Company Tree**: Contacts arranged by Directorate -> Departments -> Teams -> Positions.
- **Broadcast Alerts with Mandatory Confirmation**: Directive notices that require recipients to click "Acknowledge" with exact audit logging of timestamps.
- **WebRTC Peer-to-Peer & Relayed Audio/Video Calling and Screen Sharing**, incl. Remote Desktop assistance.
- **Embedded Web Database Studio**: Direct SQL query runner, schema viewer, data editor, and 1-click database backup without external database software.
- **Lightweight Windows Service Installer**: 1-click installation as a Windows Service with firewall configuration and zero-config startup.

## Architecture Links
- [[Architecture - Overview]]
- [[Architecture - Database]]
- [[Architecture - Realtime and WebRTC]]
- [[Architecture - Key decisions]]

## Recent Activity
- 2026-09-07: Production optimization — Kanban and Bulletin Board (BBS) removed entirely (schema, API, UI); mock/demo data eliminated; `electron-builder` NSIS/portable Windows packaging shipped. See [[Logs/2026-09-07]].
- 2026-09-04: Project created, skill pack installed, technical specification drafted, and architectural documentation prepared.
