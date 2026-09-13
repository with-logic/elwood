## 2. Goals And Non-Goals

### 2.1 Goals

- Provide a TypeScript library for starting, controlling, stopping, killing,
  resuming, and tearing down interactive Claude Code and Codex CLI sessions.
- Run each agent in a real PTY so its TUI behaves as it would in a normal
  terminal.
- Start Claude from the user's normal macOS interactive login shell environment,
  including startup files such as `~/.zshrc` when that is what Terminal.app
  would load.
- Route every Claude Code and Codex hook event through Elwood via a generated
  per-session hook bridge.
- Expose every hook event to the parent app with strong TypeScript types.
- Let parent hook handlers return event-specific, strongly typed responses that
  map to Claude Code's hook output protocol.
- Provide a unified agent-control surface where callers can send messages and
  observe a rich chronological activity stream without branching on the
  underlying adapter for common chat-loop workflows.
- Fail open when no hook handler exists, a handler times out, or a handler
  fails at runtime.
- Send prompts through terminal input exactly as a human would, including
  multi-line prompts.
- Persist only session metadata needed for resume and cleanup, plus loop
  definitions that a caller explicitly creates as durable automation state.
- Avoid persisting raw terminal contents, ordinary user prompts, hook payloads,
  or conversation logs by default. A loop prompt is the narrow exception: its
  exact text is persisted because explicit recurring automation cannot be
  restored without it.
- Provide a small local test app for manual development and acceptance testing.

### 2.2 Non-Goals

- Windows or Linux support in the MVP.
- Additional non-Claude/non-Codex adapters in the MVP.
- Using Claude Code print mode (`claude -p`) as the primary control mechanism.
- Cloud execution, remote hosts, or multi-machine session sync.
- Full visual parsing of Claude's TUI as the source of truth.
- Installing or updating Claude Code or Codex, or performing the INITIAL
  authentication for a fresh install. Elwood assumes `claude`/`codex` is
  installed, on `PATH`, and initially authenticated. Elwood DOES detect a lapsed
  Claude login and can drive the interactive `/login` re-authentication flow to
  recover a session whose login expired mid-run (C-CLAUDE-17/18, C-API-43); it
  never performs the human browser sign-in itself.
- A first-class multi-session manager. Parent apps own orchestration across
  many sessions.
- Durable audit logging of terminal or hook activity.
