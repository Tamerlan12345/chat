---
date: 2026-09-07
type: architecture-module
project: "[[Projects/MyChat Analog]]"
module: Realtime and WebRTC
path: "server/src/ws"
scanned-commit: "2026-09-07-prod"
tags: [architecture, realtime, webrtc, websockets, voice-calls, signalling]
ai-first: true
---

## For future agent
This note documents the real-time event protocol and WebRTC signalling architecture in OpenMyChat as of 2026-09-07. It outlines WebSocket frame types, presence heartbeats, delivery/read receipts, audio/video calling, and peer screen sharing.

## WebSocket Protocol Overview
The real-time gateway runs on TCP port 2004 (`/ws`) alongside the HTTP REST API on the same HTTP server instance, avoiding additional open ports on corporate firewalls.

### Frame Protocol
Clients authenticate immediately upon connection using the HMAC-SHA256 session token:
```json
{ "type": "auth", "token": "<bearer_token>" }
```

### Core Event Types
- `send_message`: Client dispatches a direct or channel message frame.
- `new_message`: Server broadcasts message to target channel members or recipient.
- `message_status`: Carries `delivered` and `read` status timestamps.
- `presence`: Dispatches status changes (`online`, `away`, `dnd`, `offline`) and updates colleague directory badges.
- `typing`: Propagates typing notices with a 3-second auto-expiration debounce.
- `new_announcement`: Broadcasts urgent management notices requiring mandatory acknowledgment.
- `rd_request` / `rd_accept` / `rd_reject` / `rd_end`: Broker signalling for colleague remote desktop assistance.
- `rd_ice_candidate` / `rd_webrtc_answer`: WebRTC peer-to-peer signalling for video/screen stream and DataChannel input.

## Audio & Video Calls (WebRTC P2P)
Direct 1-on-1 audio/video calls establish a direct peer connection between employee workstations across the local network (LAN) using STUN for NAT discovery and UDP media streams, ensuring zero latency and zero data egress to external networks.
