---
date: 2026-09-07
type: architecture-module
project: "[[Projects/MyChat Analog]]"
module: Database
path: "server/src/db"
scanned-commit: "2026-09-07-prod"
tags: [architecture, database, sqlite, wal, web-studio]
ai-first: true
---

## For future agent
This note specifies the database architecture for OpenMyChat as of 2026-09-07 following the colleague-chat optimization. It documents the native `node:sqlite` storage engine, WAL pragma configuration, table schemas (without Kanban/BBS), FTS5 full-text indexing, and the embedded Web Database Studio.

## Storage Engine: Native `node:sqlite`
OpenMyChat relies on the built-in SQLite engine provided by Node.js 24 (`const { DatabaseSync } = require('node:sqlite')`).
- **Zero Native Build Dependencies**: No need for MSVC C++ toolchains, `node-gyp`, or external compilation.
- **Single File Storage**: All data resides in `server/data/mychat.db`.
- **WAL Mode**: `PRAGMA journal_mode = WAL;` allows simultaneous readers without blocking writers.
- **Integrity & Concurrency**:
  - `PRAGMA foreign_keys = ON;`
  - `PRAGMA synchronous = NORMAL;`
  - `PRAGMA busy_timeout = 5000;`

## Relational Schema Specifications
1. **`users`**: User identities, authentication hashes (scrypt), department linkage, roles, UIN, phone extension, company name, presence status.
2. **`departments`**: Hierarchical organization tree with `parent_id`, order index, and team assignments.
3. **`roles`**: Granular role-based permissions (`is_admin`, `can_broadcast`, `can_call`, `can_create_channels`, `can_upload_files`).
4. **`channels`** & **`channel_members`**: Group conference rooms, public/private/system access, membership audit.
5. **`messages`**: Direct and channel message records, message types (`text`, `image`, `file`, `voice`, `system`), reply quotes, metadata.
6. **`message_statuses`**: Tracks delivery (`delivered`) and read receipts (`read`) per message per user with timestamps.
7. **`announcements`** & **`announcement_receipts`**: Critical broadcast directives with mandatory read acknowledgment timestamps.
8. **`files`**: File transfer tracking, SHA-256 deduplication, MIME verification, physical disk path in `data/uploads/`.
9. **`audit_logs`**: Security events, login attempts, administrative changes.
10. **`server_settings`**: Key-value server configuration (`company_name`, `server_name`, `allow_registration`).

## Embedded Web Database Studio
Accessible via the Admin Console and integrated into the desktop client for administrators:
- **Table Browser**: Live grid showing columns, data types, primary keys, and row counts.
- **SQL Console**: Interactive query editor supporting arbitrary SQL statements with performance timers.
- **1-Click Backup**: Uses `VACUUM INTO 'data/backups/mychat-backup-*.db'` to generate clean hot snapshots while the server is live.
- **Maintenance**: Runs `PRAGMA integrity_check`, `VACUUM`, and `REINDEX`.
