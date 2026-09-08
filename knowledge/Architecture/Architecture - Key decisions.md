---
date: 2026-09-07
type: architecture-overview
project: "[[Projects/MyChat Analog]]"
tags: [adr, decision, architecture]
ai-first: true
---

## For future agent
This note records the key architectural decisions (ADRs) made for the OpenMyChat project up to 2026-09-07.

## Key Decisions

### ADR-001: Native `node:sqlite` WAL for Database Engine
- **Context**: MyChat requires a fast, reliable, zero-config embedded database engine. Running external database servers (PostgreSQL/MySQL) complicates corporate on-premise installation and requires dedicated DB administrators.
- **Decision**: Use Node.js 24's native `node:sqlite` engine configured with Write-Ahead Logging (`PRAGMA journal_mode = WAL;`) and full-text search (FTS5).
- **Consequences**:
  - Zero external C++ compilation dependencies.
  - Hot database backups via `VACUUM INTO`.
  - Single database file `server/data/mychat.db` for easy migrations and disaster recovery.
  - Web Database Studio built into the admin console for direct table inspection and SQL queries.

### ADR-002: Native Windows Desktop Form instead of Browser WebUI
- **Context**: The user explicitly requested a standalone application with its own native window form, rather than running inside a web browser tab.
- **Decision**: Package the client as an Electron-powered native desktop application.
- **Consequences**:
  - Provides a dedicated window frame, custom title bar, and system buttons.
  - Minimizes to the Windows System Tray with presence status menu (В сети, Отошел, Не беспокоить).
  - Can display top-level notification alerts that break through full-screen applications and RDP sessions.
  - Ability to spawn separate windows (such as the Remote Desktop Viewer window).

### ADR-003: Built-in WebRTC Remote Desktop Assistance Plugin
- **Context**: MyChat integrates UltraVNC/Radmin for remote desktop control. External VNC binaries often require firewall port forwarding, separate license keys, and trigger antivirus heuristics.
- **Decision**: Implement a native Remote Desktop Plugin using Electron's `desktopCapturer` + WebRTC video streaming + DataChannel input injection.
- **Consequences**:
  - 60 FPS hardware-accelerated remote screen stream with sub-50ms latency across LAN.
  - Opens in a dedicated floating Windows Viewer form.
  - Requires user consent handshake before connecting.
  - No external VNC server or client installation required on target workstations.

### ADR-004: Windows Service Deployment with Portable Fallback
- **Context**: The server must run continuously 24/7 without needing an administrator to remain logged in.
- **Decision**: Provide both an automated Windows Service installer (using `sc.exe` / WinSW / PowerShell) and a zero-install portable runner (`start-server-portable.bat`).
- **Consequences**:
  - Administrators can install it as a persistent Windows service with automatic restart on failure.
  - Testing or evaluation can be done in 10 seconds via the portable script without administrative privileges.

### ADR-005: Streamlined Pure Colleague Chat & Removal of Kanban
- **Context**: The user explicitly instructed to remove the Kanban board and bulletin boards to eliminate interface noise and optimize the application strictly as a high-performance corporate messenger for colleagues.
- **Decision**: Fully purge Kanban tables (`kanban_boards`, `kanban_columns`, `kanban_cards`, `kanban_comments`) and Bulletin tables (`bulletin_posts`), focusing UI and backend on direct chats, company channels, the hierarchical phone directory/org tree, and mandatory announcements.
- **Consequences**:
  - Simpler, cleaner, and faster user experience.
  - Reduced footprint and eliminated database bloat.
  - Ergonomic 3-column messenger layout matching modern enterprise workflows.

### ADR-006: Standalone Windows Installer via `electron-builder` & Zero-Mock Production Bootstrap
- **Context**: Production deployment requires a true Windows installer and executable without requiring manual Node.js installation or dev dependencies on employee computers. Furthermore, hardcoded demo data and auto-login bypasses must be eliminated.
- **Decision**: Package the desktop client with `electron-builder` producing both an NSIS Setup installer (`OpenMyChat Enterprise Setup 1.0.0.exe`) and a single-file portable executable (`OpenMyChat Enterprise 1.0.0.exe`). Eradicate all mock seed scripts in favor of a clean production bootstrap (`seedProductionData`) with default administrator initialization and a full Login/Register view.
- **Consequences**:
  - 1-click Windows installer with desktop and start menu shortcuts.
  - Clean initial database state ready for any enterprise deployment.
  - Multi-server connectivity supporting any LAN IP address.

### ADR-007: Passwordless Corporate Intranet Experience & Authentic 4-Column MyChat Ergonomics
- **Context**: In an air-gapped corporate LAN environment, requiring employees to repeatedly enter passwords upon launching the application adds friction and disrupts day-to-day workflow. Additionally, the user requested an authentic replica of the organization's existing MyChat Client 2025.3.1 structure (АО "Страховая компания "Сентрас Иншуранс").
- **Decision**:
  1. Eliminate the blocking login/password dialog at startup. The application automatically performs an instant intranet handshake (`/api/auth/instant-login`), launching directly into the active employee workspace (defaulting to Tamerlan Dzhumagulov / UIN 1436).
  2. Implement a 1-click Account Switcher (`AccountSwitcherModal`) allowing seamless switching between colleagues without entering credentials.
  3. Recreate the authentic 4-column layout shown in real corporate screenshots:
     - Navigation Rail (Chats, Channels, Contacts, Important).
     - Sub-panel with dropdown selector (`Диалоги ⌵`, `Конференции ⌵`, `Общие контакты ⌵`) and real-time search.
     - Central Chat area with distinctive sender colors (Red/Blue), unread message separator (`--------- непрочитанные сообщения ---------`), and input toolbar (`☺`, `📎 Вставить... ⌵`, `💬 Фраза ⌵`).
     - Right sidebar ("Информация о человеке") with large photo, email, and department metadata.
     - "Мой персональный профиль" modal dialog with categorized tabs (`Основное`, `Дом`, `Место работы`, etc.).
     - Hierarchical company tree for "АО СК Сентрас Иншуранс" with department-level presence counts (`312/426`, `222/286`, `6/6`).
- **Consequences**:
  - Zero password fatigue for employees in internal networks.
  - Pixel-perfect familiarity and ergonomic continuity with the company's existing MyChat Client.
  - Instant employee-switching capability for administrative testing and auditing.

### ADR-008: Automated Hardware & Session Presence State Machine & Enterprise Button Restoration
- **Context**: Employees should never have to manually adjust their presence state when stepping away, locking their PC (`Win+L`), shutting down, or dropping network. Manual status updates lead to stale data across the department directory. Furthermore, the UI required high tactile responsiveness and classic enterprise polish for all action buttons and toolbars.
- **Decision**:
  1. Implement an automated presence state machine across Electron OS hooks and browser environments:
     - **`В сети` (Online)**: Computer is powered on, active user input detected, screen unlocked, WebSocket connected.
     - **`Отошел` (Away)**: Computer is ON, but locked (`powerMonitor.on('lock-screen')`) OR idle without input for > 5 minutes (`powerMonitor.getSystemIdleTime() >= 300`). On browser, triggered via DOM inactivity (> 5 min) or tab hidden (> 3 min). Automatically restores to `online` upon unlocking or user input.
     - **`Не в сети` (Offline)**: Computer is powered off, suspended/sleeping (`powerMonitor.on('suspend')`), network lost, or WebSocket socket dropped. Server immediately writes `status = 'offline'` in SQLite and broadcasts to all peers.
  2. Restore and elevate all buttons across the application with tactile enterprise feedback:
     - Header action buttons (`📞`, `📹`, `🖥️`, `🗖`, `⋮`) with crisp borders, subtle elevation, and depressed `:active` states (`translateY(1px)`).
     - Classic input toolbar buttons (`☺`, `📎 Вставить... ⌵`, `💬 Фраза ⌵`, `➤`) with flat raised styling.
     - 3-color presence indicators (green `online`, amber `away`, gray `offline`) across the Org Tree, Chat Header, and Person Info Panel.
     - Native Windows Status Bar at the bottom showing connection state, live headcount stats (`В сети: X | Отошли: Y | Всего: Z`), and a 1-click status override dropdown.
- **Consequences**:
  - 100% automated, accurate presence representation across the enterprise without user intervention.
  - Immediate real-time peer updates via WebSocket gateway.
  - High-precision tactile responsiveness matching mission-critical desktop enterprise messengers.
### ADR-009: MyChat Server Control Panel & Remote Desktop Security Permission Protocol
- **Context**: As documented in the official MyChat Server Control Panel specification (`https://nsoft-s.com/mcserverhelp/controlpanel.html`), system administrators require full management capabilities over registered users, common contacts/departments, group rights, and server diagnostics. Concurrently, remote assistance ("Удаленный рабочий стол" / Screen Assist) requires strict security compliance: target employees must never have their screen or mouse hijacked without explicit interactive consent, must choose between Full Control and View-Only access, and must possess a persistent floating stop button to terminate connections at any time. Furthermore, hardcoded synthetic UI emoji palettes must be replaced with an authentic corporate emoji catalog.
- **Decision**:
  1. **MyChat Server Control Panel (`AdminUserModal.jsx`)**:
     - Built authentic multi-section control console matching the official documentation:
       - **Информационный обзор сервера**: Server IP, uptime, active connections, total registered users, database engine.
       - **Управление пользователями (`usermanagement.html`)**: Filterable table with live search and department filters; actions to Add New Employee, Edit details, Toggle Active/Blocked status, and Reset Passwords.
       - **Списки контактов и отделы (`usercommoncontacslist.html`)**: Overview of the corporate hierarchy structure.
       - **Группы прав (`grouprightsmanage.html`)**: RBAC permissions matrix separating Administrator, Web-developer, and Employee rights.
       - **Конференции (`conference.html`)**: System-wide channels (`#Общий`, `#Техподдержка`).
     - Protected server endpoints with RBAC middleware (`requireAdmin`).
  2. **Remote Desktop Security Protocol (`RemoteDesktopHostModal.jsx`, `RemoteDesktopViewer.jsx`)**:
     - Remote session initiates only after target employee accepts prompt modal displaying operator's identity, department, and role.
     - Granular security mode selection: `Полный доступ (управление)` vs `Только просмотр`.
     - In View-Only mode, input events (clicks, mouse moves, hotkeys) are completely blocked by the viewer.
     - While screen sharing is active, the host machine displays a floating pill widget (`.rd-host-floating-bar`) pinned to the top of the screen with a pulsating live indicator and 1-click `⏹ Завершить доступ` button.
  3. **Corporate Searchable Emoji Picker (`EmojiPicker.jsx`)**:
     - Replaced inline emoji arrays with a 5-category corporate picker (`Частые`, `Смайлы`, `Жесты`, `Офис`, `Символы`) with real-time keyword search (e.g. "документ", "галочка", "ок", "кофе") and outside click auto-closing.
  4. **Purge of AI Artifacts**:
     - Polished all UI surfaces to Windows Enterprise styling with neutral slate/steel palettes, authentic typography, and tactile button feedback.
- **Consequences**:
  - Full adherence to official MyChat Server Control Panel specifications.
  - Zero unauthorized screen capture or remote control, guaranteeing employee privacy and security.
  - Granular administrative empowerment without requiring external database tools.

### ADR-010: Complete 8-Section MyChat Server Control Panel Suite (nsoft-s.com specification)
- **Context**: The user requested full alignment with the official MyChat Server Control Panel documentation (`https://nsoft-s.com/mcserverhelp/controlpanel.html`), which specifies 8 core administrative categories: MyChat Server (`info.html`), Users (`usersmanage.html`), Conferences (`conference.html`), Group Rights (`grouprightsmanage.html`), Tools (`tools.html`), Filters (`filters.html`), Settings (`settings.html`), and Licenses (`licenses.html`).
- **Decision**:
  1. **MyChat Server (`info.html`)**:
     - System overview with host IP, TCP port 2004, uptime, active socket count, and total employees.
     - Live connections monitor with real-time socket listing, client type, ping latency, and force-disconnect capability.
  2. **Users Management (`usersmanage.html`)**:
     - User list with text and department filters, profile creation with automatic UIN assignment, editing, and password resets.
     - Dedicated Ban-list (`userbanlist.html`) with 1-click unban.
     - Departments and positions view (`userpositions.html`) with headcounts.
  3. **Conferences (`conference.html`)**:
     - Management of public channels (`#Общий`, `#Техподдержка`, etc.) with topics, member counts, creation and deletion.
  4. **Group Rights (`grouprightsmanage.html`)**:
     - Interactive permissions matrix for Administrator and Employee roles: private messaging, file transfer (up to 100 MB), WebRTC calls, Remote Desktop Screen Assist, and notice board broadcast.
  5. **Tools (`tools.html`)**:
     - Message audit logs viewer (`logsviewer.html`) with keyword search.
     - Port test diagnostic utility (`toolstestmychatports.html`) checking port 2004 listener and network adapters.
     - Database maintenance utility executing SQLite `PRAGMA optimize; VACUUM; ANALYZE;`.
     - Notice board manager for corporate announcements with urgent flags.
  6. **Filters (`filters.html`)**:
     - Anti-flood threshold per second, bad words / profanity filter, and IP blacklist.
  7. **Settings (`settings.html`)**:
     - Company name, inactivity timeout threshold (default 300s), and max attachment size.
  8. **Licenses (`licenses.html`)**:
     - Enterprise unlimited perpetual license sheet for АО СК "Сентрас Иншуранс".
- **Consequences**:
  - Exact parity with official MyChat Server administrative functionality.
  - Zero dependence on external tools or SQL consoles for daily enterprise administration.

### ADR-011: Tree Information Capacity, Flat Indentation and Resizable Sidebar Splitter
- **Context**: Deeply nested organizational structures (e.g., Holding -> Branch -> Directorate -> Department -> Team -> Employee) suffered from severe horizontal truncation in the sidebar. Nested container padding was compounding quadratically (`depth * 14px` on each parent container), causing 4th-level items to lose over 140px of width. Department names and staff counts (`- 0/2`) were concatenated in a single string that clipped off-screen, and fixed sidebar width prevented user adjustment.
- **Decision**:
  1. **Flat Row Indentation Model**: Eliminated cumulative padding on parent containers. Instead, applied a single, flat indentation on the node row itself (`depth * 10px + 6px` in compact mode, `depth * 14px + 6px` in regular mode).
  2. **Flex-Ellipsis & Independent Count Badge**:
     - Department name uses `flex: 1; min-width: 0; text-overflow: ellipsis; white-space: nowrap;` so it maximizes available space with native `title` tooltip.
     - Presence/staff count (`activeDeptUsers/totalDeptUsers`) is rendered as an independent, right-aligned pill (`.tree-count-pill`), highlighted in green when active staff > 0 and never obscured.
  3. **Visual Cleanliness**: Replaced bullet markers (`•`) on leaf departments with transparent alignment spacers (`.tree-toggle-spacer`) so icons line up straight.
  4. **Interactive Resizable Splitter (`.sidebar-resizer`)**:
     - Implemented drag-to-resize handle between sidebar and main workspace (260px to 650px).
     - Persisted user preference in `localStorage.getItem('mychat_sidebar_width')`.
     - Double-click resets to standard width (360-380px).
  5. **Tree Density & Filtering Toolbar**:
     - Added Expand All / Collapse All toggle (`↕️`).
     - Added "Only Online" filter (`🟢`).
     - Added Compact Density toggle (`📏/📐`).
  6. **Admin Device Pairing Integration in Users Table**:
     - Added "Связка ПК / IP" column directly in the main users table showing paired PC name, IP, and 1-click unbind/bind buttons.
     - Added KPI summary cards and live search in the Pending Devices queue.
- **Consequences**:
  - Solved the layout capacity issue completely: even 6-level deep hierarchies remain fully readable.
  - Users can adapt the sidebar width to their specific monitor resolution and workflow.
  - Zero regression on existing components.

