## 1. Overview

Elwood lets an application control an agentic coding CLI that is running in its
native interactive terminal mode, without forcing a human to operate the TUI.

The first supported tool is Claude Code. The second supported tool is OpenAI
Codex CLI. Elwood starts the selected agent inside a real pseudoterminal,
configured so the agent sees the same kind of interactive shell session it would
see if the user opened Terminal.app and ran the CLI manually. Elwood then
controls the session by writing terminal input, and observes the agent primarily
through tool-specific hooks routed over local IPC.

The core premise is deliberate: the agent should not know it is running in a
special wrapper. Elwood does not replace Claude Code or Codex with print mode,
non-interactive mode, SDKs, or custom protocols. It runs the real interactive
TUI and wraps it.

Parent applications can use Elwood headlessly, or attach a terminal renderer
such as xterm.js to show the live session. A likely parent app is a local
Tauri-style desktop app that manages many agent sessions, renders their status,
and lets a user inspect the actual terminal when needed.
