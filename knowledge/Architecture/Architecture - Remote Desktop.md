---
date: 2026-09-04
type: architecture-module
project: "[[Projects/MyChat Analog]]"
module: Remote Desktop Plugin
path: "desktop/src/main/remote-desktop"
scanned-commit: "initial"
tags: [architecture, remote-desktop, vnc, webrtc, electron, desktop-assistance]
ai-first: true
---

## For future agent
This note specifies the architecture of the Remote Desktop Plugin (analogue to MyChat VNC/UltraVNC) as of 2026-09-04. It describes the permission handshake, stream capture via DesktopDuplication/WebRTC, separate Windows viewer form, and input injection.

## Plugin Overview
In corporate environments, system administrators frequently need to assist employees or manage remote stations. Similar to the UltraVNC/Radmin integration in MyChat:
1. **Access Trigger**: Right-click on any user in the Company Org Tree or chat header -> select **"🖥️ Удаленное управление компьютером" (Remote Desktop Control)**.
2. **Handshake & Consent**:
   - The server pushes a high-priority WebSocket prompt to the target machine.
   - A modal dialog appears on the remote employee's screen:
     > *"Администратор [Имя] запрашивает удаленное управление вашим компьютером. Разрешить доступ?"*
     > `[ ✓ Разрешить ]`   `[ ✕ Отклонить ]`
   - Only upon explicit user consent (or automatic admin token for unattended servers), the session begins.
3. **Dedicated Viewer Window Form**:
   - The operator receives a **separate floating Windows Form** (`viewer-window.ts`).
   - Does not clutter the main messenger chat form.
   - Features:
     - 60 FPS hardware-accelerated remote desktop display.
     - Scaling modes: Fit to window / 100% Original with scrolling.
     - Multi-monitor selection toolbar.
     - System key injection (`Ctrl+Alt+Del`, `Win+L`, `Alt+Tab`).
     - Bi-directional clipboard synchronization.
     - Mouse events: `mousemove`, `mousedown`, `mouseup`, `wheel`, context clicks.
     - Keyboard events: `keydown`, `keyup` mapping.
     - One-click "Disconnect & Revoke Access" button.
