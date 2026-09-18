## 4. Product Architecture

### 4.1 Layers

Elwood has three conceptual layers:

1. **PTY layer.** Starts and owns the shell/agent process, terminal input,
   terminal output, resize, graceful stop, force kill, and process status.
2. **Agent adapter layer.** Adds tool-specific startup, generated config,
   hook bridge, session metadata, and resume behavior. MVP adapters: Claude Code
   and Codex CLI.
3. **Public library layer.** Exposes TypeScript APIs and typed events to parent
   applications.

The PTY layer and a headless xterm.js terminal model are required. Elwood MUST
write PTY output through the headless terminal before inspecting visible TUI
state, warnings, or startup prompts. Elwood MUST send `sendPrompt` and
`sendKeys` input through the headless terminal input path so parent app input,
programmatic prompts, and low-level keys share one terminal control mechanism.

PTY output is submitted to xterm's ordered write buffer without serializing each
chunk behind a separate timer. Adjacent chunks may be coalesced into bounded
render batches of at most 64 KiB, flushing sooner when full or after a 4 ms
scheduling window (subject to host event-loop scheduling); raw byte order is
preserved, while event chunk boundaries and
intermediate frames are not guaranteed. Render observers inspect each completed
batch before subsequent terminal writes are parsed. Real PTY
output pauses at 1 MiB of unrendered UTF-8 data and resumes below 512 KiB, without
dropping output. A paused PTY resumes as soon as its child process exits, and is
not paused again afterwards, so a backlog still draining at exit cannot strand
unread output behind a pause. The high-water mark can be exceeded by the single
chunk already delivered; OS/native buffers are outside this accounting. This is
backpressure, not a total process-memory cap. Disposing the terminal cancels pending render
notifications and settles outstanding write and `settled()` promises.

### 4.2 macOS shell behavior

On macOS, Elwood MUST start the PTY in the user's configured shell in a way that
matches the effective environment of opening Terminal.app and running the agent.
The implementation should use the user's login shell and interactive/login flags
appropriate for that shell. For the common zsh case, this is expected to behave
like an interactive login shell and load the user's normal startup files.

This interactive login form (`-l -i` for zsh) applies to both the **agent PTY**
and one-shot, non-PTY preflight probes (`--version`, `update`, `--help`). The
same shell startup files MUST resolve the CLI for every lifecycle operation so
preflight, update, launch, and resume cannot operate on different installations.

Elwood MUST provide diagnostics or tests proving that environment variables from
the user's shell startup are visible to the launched agent process.

### 4.3 Claude settings behavior

Elwood MUST NOT mutate `.claude/settings.local.json` by default.

For each Claude session, Elwood generates a session-scoped settings file or JSON
object containing only Elwood's necessary overrides:

- hook bridge handlers for every Claude hook event;
- any session-specific environment/settings required for routing.

Elwood launches Claude with Claude Code's `--settings <file-or-json>` mechanism
and relies on Claude Code's native settings merge precedence. Omitted keys in
Elwood's generated settings must leave user, project, and local settings intact.
Requested permission mode and allowed/disallowed tool policy may be supplied as
Claude CLI flags instead of generated settings when Claude exposes a stable flag
for that policy.

Decision note: Claude currently advertises both camelCase and kebab-case aliases
for tool-policy flags, but Claude's bundled docs and older CLI references name
`--allowedTools` and `--disallowedTools`. Elwood uses those documented camelCase
flags to maximize compatibility. The tool rule list is encoded as one
comma-separated flag value because current `claude --help` explicitly accepts
comma-separated or space-separated tool lists.

Beyond the allow/deny rule pair, `tools` exposes Claude's `--tools` flag — a
true allowlist over the built-in tool set where only the named tools exist
and newly added CLI tools default to absent. An empty `tools` array encodes
`--tools ""`, which Claude documents as disabling all tools. `allowedTools`/
`disallowedTools` govern permission rules; `tools` governs existence.

### 4.4 Codex configuration behavior

Elwood MUST NOT mutate `.codex/config.toml`, `.codex/hooks.json`,
`~/.codex/config.toml`, or `~/.codex/hooks.json` by default.

For each Codex session, Elwood generates only Elwood-owned runtime files under
the Elwood session metadata directory, then launches Codex with session-scoped
`--config` overrides that install hook bridge handlers for every supported Codex
hook event. Elwood reserves `features.hooks=true` and `hookTrust="trust-all"`
as session-scoped Codex overrides because Codex hooks must be enabled and trusted
for Elwood to function. User, project, managed, and system Codex config must
still merge through Codex's normal precedence rules.

Decision note: `features.hooks=true` is treated as Elwood-owned configuration,
not caller configuration. Without it, some Codex versions can parse hook config
without running hooks, which would make Elwood observe less than the parent app
expects. Elwood-owned hook command overrides may be emitted before caller
`configOverrides`, but reserved enablement/trust overrides MUST be emitted after
caller overrides so callers cannot accidentally disable the bridge.

Codex hook trust is a Codex security feature, but Elwood is not useful without
trusted hooks. Elwood MUST always allow Codex hooks to run. It should use
`hookTrust="trust-all"` in its session-scoped Codex config and should also use
Codex's invocation-scoped hook-trust bypass flag when the installed CLI
advertises it. If Codex still shows an interactive `Hooks need review` prompt,
Elwood MUST select the numbered option whose label is `Trust all and continue`
through PTY input; it must not assume that option always has the same number.
Prompt detection MUST operate on raw PTY output, including ANSI-styled and
cursor-addressed full-screen output where menu text may arrive as `2.Skip`
rather than as line-oriented `2. Skip` text.

### 4.5 Environment fidelity

An Elwood session MUST behave like the same agent launched from the user's own
terminal in the same working directory, plus Elwood's additive instrumentation.
Concretely:

- Sessions launch through the user's login+interactive shell in the caller's
  `cwd`, inheriting the parent process environment plus Elwood's own session
  variables (such as `ELWOOD_SESSION_ID`).
- Elwood MUST NOT modify, move, or shadow user-owned configuration: user and
  project Claude settings, `CLAUDE.md`/`AGENTS.md`, skills, MCP configuration,
  and Codex `config.toml` all load exactly as they would without Elwood.
- Elwood's hook wiring MUST be additive. User-configured hooks for the same
  events continue to run alongside Elwood's bridge hooks. For Claude this holds
  because `--settings` is a merged settings source; for Codex this holds
  because CLI `-c hooks.*` overrides combine with `config.toml` hook groups
  (verified against codex-cli 0.142).
- Known deviations MUST be documented rather than silent. Current deviations:
  Codex hook trust is bypassed inside Elwood sessions because Elwood's reserved
  `hookTrust="trust-all"` and trust-bypass flag apply to the whole session, so
  a user hook that Codex would normally prompt about runs without a prompt; and
  caller-provided `settingsOverrides` (§5.1) may intentionally shadow
  project-level Claude settings keys because the generated `--settings` file is
  a high-precedence source.
