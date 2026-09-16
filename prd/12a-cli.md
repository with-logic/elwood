## 12A. Headless Command-Line Interface

Elwood ships a compiled JavaScript executable named `elwood` for macOS and
Node.js 24 or newer. Local, git, and packed-tarball installs MUST run emitted
JavaScript from `dist`; an installed package MUST NOT depend on Node's native
TypeScript loading. The package's root import MUST likewise resolve to emitted
JavaScript and declarations.

### 12A.1 Commands and input

The primary form is `elwood [options] [prompt...]`. `elwood run [options]
[prompt...]` is an exact explicit equivalent. `help`, `run`, and `config` are
commands only when they are the first argument before `--`; prompt words are
otherwise joined with spaces. `elwood help`, `elwood --help`, and `elwood
--version` MUST complete without reading user configuration or launching an
agent. `elwood config --help` and `elwood config help` MUST likewise print
config-specific help without reading configuration. An invocation with no
arguments is another exact top-level help form and MUST NOT read piped or terminal
stdin. `elwood run` remains an explicit run and therefore requires prompt input,
including when that input comes only from piped stdin.

`resume`, `interactive`, `sessions`, and `models` are further first-argument
commands with the same reservation rule; they are specified in §12A.7 through
§12A.10. Each accepts `-h`/`--help` and prints the top-level help without
reading configuration or launching an agent.

A new session defaults to the invocation directory; `-C`/`--cwd` overrides it.
When no flag, environment variable, or configuration key selects an agent, a
new session auto-detects one: Elwood tries `claude` first, then `codex`, and
uses the first whose command resolves in the user's login shell — the same
resolution the agent launch itself uses (§4.2) — without running either agent.
Both probes run concurrently; the order only decides the winner. The resolved
agent reports the source `auto-detected`. When neither command resolves, the
invocation fails before any launch with the stable code `no_agent_found` and
status 2; the message names both agents, how to install one, and that
`--agent`, `ELWOOD_AGENT`, or the config `agent` key selects one explicitly.
When the probe itself cannot run — the login shell is missing or broken, or the
probe times out — the invocation fails with the same code and status but the
message names the shell and the underlying error and says the probe failed,
because nothing is then known about which agents are installed. Adapter-specific
options that conflict with an auto-detected agent are reported as conflicting
with the auto-detected agent, and the recovery additionally offers selecting the
other adapter with `--agent`. Resume never auto-detects; it uses the stored
adapter. Elwood MUST fail when the selected adapter is unavailable and MUST NOT
silently fall back to another adapter.

Non-empty piped stdin is appended to positional prompt text after one blank
line; terminal stdin is never read. Whitespace-only input is a usage error.
Combined input has an 8 MiB UTF-8 limit that is enforced incrementally before
session creation. Repeatable `--image <path>` flags attach readable files, in
flag order, to the same user turn; paths resolve from the effective workspace.

### 12A.2 Execution and lifecycle

CLI turns use the public normalized turn boundary and preserve normal login
shell, workspace, instruction, settings, skill, MCP, and hook behavior. By
default Elwood answers only the folder/directory and extension trust classes
documented in §5.1. `--no-trust` disables that authorization but does not
disable Codex's session-wide hook-trust bypass, which also covers non-Elwood hooks. Any other recognized blocking
prompt fails as `blocked_prompt` and reports only its stable rule label.

The built-in non-interactive launch posture is Claude `dontAsk`, and Codex
`workspace-write` with approval policy `never`. Flags and global configuration
may select the adapter, model, reasoning effort, persona, state directory,
Claude permission mode, Codex sandbox, and Codex approval policy. An
adapter-specific option is a usage error for an incompatible adapter.

`--high-trust` is the agent-neutral "never ask for permissions" switch (§5.1,
§5.5): for whichever adapter runs, it expands to Claude `bypassPermissions` or
Codex `danger-full-access` with approval policy `never`. It layers like every
other setting (`--high-trust` / `--no-high-trust`, `ELWOOD_HIGH_TRUST`, the
`highTrust` config key, built-in `false`), and `--no-high-trust` reverses an
inherited `true`. An effective `true` from a flag or environment variable
combined with an explicit per-agent posture flag or variable
(`--claude-permission-mode`, `--codex-sandbox`, `--codex-approval-policy`, or
their `ELWOOD_*` forms) in the same invocation is a usage error naming both
sources, whether the run is new or resumed. Saved `claude.permissionMode`,
`codex.sandbox`, and `codex.approvalPolicy` config keys are simply overridden by
high trust; a saved `highTrust: true` is itself overridden field by field by an
explicit per-agent flag or variable. On resume, `--high-trust` behaves like the
other posture flags: it overrides the stored posture for the resumed adapter.

Turns have no whole-invocation timeout by default. `--timeout` accepts a
positive safe integer followed by `ms`, `s`, `m`, or `h`; its deadline spans
launch, persona setup, and the user turn. Signal handlers are active before
launch. The first `SIGINT` requests interruption and cleanup, a repeated
`SIGINT` force-kills the process tree, and an interrupted invocation exits 130.

New and resumed headless runs preserve their Elwood-owned state after every
outcome by default, after stop-or-kill cleanup. `--keep` explicitly selects this
default. `--ephemeral` instead requests teardown for either a new or resumed
run; it cannot be combined with `--keep`. Teardown does not undo workspace
changes or remove history owned by the underlying agent. A preserved run reports
its resumable session ID on stderr in text mode only when `--show-session-id`
is supplied. By default, successful text output contains only the agent response;
`elwood sessions` lists retained IDs. The flag affects only the text footer, not
the `sessionId` field in JSON/JSONL, and emits nothing for ephemeral sessions. A resume uses `--resume <id>` to load exactly the
stored adapter and cwd; it never falls back to a new conversation, and `--cwd`
is therefore rejected with `--resume` rather than overriding the stored
workspace. Explicit adapter conflicts are usage errors. Before launch, resumed state and its cwd MUST satisfy the private,
owner-matched, regular-file and directory constraints in §12A.5. Resume
preserves state after every outcome unless `--ephemeral` requests teardown.

A persona applies only to a new session. Elwood runs it as a separate completed
setup turn and discards that turn's response before observing the user turn. It
is a real agent turn: tools and other side effects performed during persona setup
remain even though its assistant response is omitted from CLI output. Explicit
persona plus resume is a usage error. An agent process exit before
CLI-requested cleanup is `agent_exited`, including a zero-status exit. Response
data already collected remains available on later failure.

Cleanup runs exactly once. A cleanup failure never masks a primary usage,
agent, timeout, or interruption outcome, and it changes an otherwise successful
invocation to failure.

### 12A.3 Output protocols

Stdout is a protocol channel. Human diagnostics, warnings, progress, cleanup
failures, and text-mode preserved-session notices go only to stderr. Production
output MUST exclude raw PTY frames, raw hook payloads, terminal screen contents,
stacks, bridge credentials, and terminal escape sequences.

Text is the default output. It writes the combined assistant response — every
observed assistant text message in order, separated by one blank line — with one
trailing newline when non-empty and zero bytes for an empty response. Live session
warnings are quiet by default for text and JSON runs, including model probes.
`--verbose` enables concise sanitized warnings and elapsed-time phase, tool-name,
and cleanup progress on stderr without replaying assistant or thinking text.
`--debug` also enables warnings. JSONL always represents warnings as ordered
records without duplicating them on stderr. Fatal errors and `sessions` warnings
about omitted unreadable records remain visible without verbosity. `--debug` emits
full sanitized normalized event details to stderr and is intended for diagnosis
rather than routine progress. `--stream` is text-only, emits assistant chunks once with one
blank line between distinct messages, preserves partial output on failure, and
adds one trailing newline when non-empty.

`--output json` emits one version-1 terminal result or error document containing
the record type, adapter, combined response, nullable session ID, integer
duration in milliseconds, and cleanup outcome. A result record's `agent` is
always the adapter that ran. An error record's `agent` is the adapter that ran
or was selected; it is `null` when the failure happened before anything selected
an adapter — for example `no_agent_found`, or an argument or configuration
failure in an invocation with neither `--agent` nor an honored `ELWOOD_AGENT`. `--output jsonl` emits
monotonically sequenced version-1 normalized text, thinking, tool, status, and
warning records, followed by exactly one terminal result or error record with
the combined response. Every JSONL record includes a non-negative integer
`elapsedMs`; tool records include a sanitized `toolCallId` when the adapter
provides one so calls and results can be paired. A parseable, explicit structured-output selection
also represents argument, configuration, and runtime failures in that protocol.

All writes MUST honor stream backpressure. Downstream `EPIPE` stops output and
cleans up without an uncaught diagnostic. Consumer closure exits 0 unless an
earlier primary outcome already established a nonzero status.

### 12A.4 Configuration

The user config path is a non-empty `$ELWOOD_CONFIG`, otherwise
`$XDG_CONFIG_HOME/elwood/config.json` when the XDG base is absolute and
non-empty, otherwise `~/.config/elwood/config.json`. V1 does not read
project-local configuration.

Configuration is a strict version-1 JSON object. Documented keys are
`schemaVersion`, `agent`, `output`, `timeout`, `trust`, `highTrust`, `stateDir`,
`verbose`, `stream`, `persona`, `claude.model`, `claude.reasoningEffort`,
`claude.permissionMode`, `codex.model`, `codex.reasoningEffort`,
`codex.sandbox`, and `codex.approvalPolicy`. Config MUST NOT set prompt, cwd,
keep, ephemeral, resume ID, or images.

Supported environment variables are `ELWOOD_AGENT`, `ELWOOD_OUTPUT`,
`ELWOOD_TIMEOUT`, `ELWOOD_TRUST`, `ELWOOD_HIGH_TRUST`, `ELWOOD_STATE_DIR`,
`ELWOOD_VERBOSE`, `ELWOOD_STREAM`, `ELWOOD_PERSONA`, `ELWOOD_MODEL`,
`ELWOOD_REASONING_EFFORT`, `ELWOOD_CLAUDE_PERMISSION_MODE`,
`ELWOOD_CODEX_SANDBOX`, and `ELWOOD_CODEX_APPROVAL_POLICY`. Boolean variables
accept only `true` or `false`. Precedence is command-line flags, environment,
user configuration, then built-in defaults. The `agent` setting has no fixed
built-in default: when nothing selects it, a new session auto-detects the first
available of `claude` then `codex` as described in §12A.1.

Boolean settings inherited from environment or configuration remain reversible
per invocation: `--no-stream`, `--no-verbose`, and `--no-high-trust` explicitly
select false with normal flag precedence. `--no-defaults` ignores the user configuration document
and every `ELWOOD_*` run-setting variable for that invocation, while retaining
command-line flags, built-in defaults, the normal home/XDG state-location rules,
and the selected agent's inherited process environment.

`elwood config path`, `show`, `get`, `set`, and `unset` manage documented dotted
keys without launching an agent; `show` prints only the saved document.
`elwood config effective [run options]` resolves and validates launch/output
settings without reading prompt input or starting an agent, then prints one
version-1 JSON document containing the config path and whether it was loaded,
plus the effective agent, model, workspace, timeout, output controls (including
`head`), state directory, `highTrust`, and adapter permission posture. When high
trust decides a posture value, that value's source is the high-trust source
(`--high-trust`, `ELWOOD_HIGH_TRUST`, or the config path and `highTrust` key),
so the document explains WHY the posture is what it is. Claude posture includes
`permissionMode`, `allowedTools`, `disallowedTools`, and `tools`; exact resume
inspection merges persisted posture by the same field-by-field rules as launch so
the document reports the tool policy the resumed process will receive. Every
reported setting includes its source (`--flag`, `ELWOOD_*`, the saved config path
and key, stored session, invocation context, auto-detected, built-in, unset, or
not applicable). When nothing selects the agent, `config effective` reports the
auto-detected agent with source `auto-detected`, resolved by the same
login-shell command probe a run would use (§12A.1), so the document shows the
agent that invocation would actually launch; the probe only asks the shell
whether the command resolves and never starts an agent, and a missing agent is
the same `no_agent_found` failure a run would report.
Mutations are atomic and silent on success;
config parsing and writes reject unknown keys, unknown schema versions,
symlinks, non-regular files, wrong ownership, and non-private permissions.

### 12A.5 State, failures, and compatibility

CLI-owned state defaults to `$XDG_STATE_HOME/elwood` when that base is absolute,
otherwise `~/.local/state/elwood`. It never defaults to the invocation
workspace. CLI state directories and records MUST be private, owner-matched,
regular where applicable, symlink-safe, and atomically written. One session
identity supports at most one live owner; concurrent exact resumes may fail on
the adapter's underlying startup conflict in v1.

Exit status is 0 for success or consumer closure, 1 for agent or cleanup
failure, 2 for usage or configuration failure, 124 for timeout, and 130 for
interruption. A primary nonzero status survives cleanup failure. Text errors are
concise and go to stderr while structured protocols retain stable error codes.
Unknown long options identify the token and suggest the nearest documented
option when the match is unambiguous. Validation messages identify relevant
paths and name the inherited environment/config source when it explains a
conflict, together with a concrete recovery flag when one exists. Debug mode may
include sanitized event detail but never weakens §12A.3. Static arguments, environment, config, cwd, image, and option
compatibility MUST be validated before session creation whenever validation
does not require a stored resume record.

### 12A.6 Same-terminal head mode

`--head` is an opt-in, view-only terminal mirror for a run. It requires both a
terminal stdin and terminal stderr; the latter is the dedicated display channel,
so stdout retains the selected text or JSON protocol and may still be redirected.
The flag is invocation-only: it has no environment or configuration equivalent.
An unavailable controlling terminal is a usage failure detected before session
creation. Because the headed display exclusively owns the terminal while the
turn runs, `--head` is incompatible with `--stream`, `--verbose`, `--debug`, and JSONL's
live record protocol. It remains compatible with final text and JSON output.

Head mode MUST render the raw `terminal:data` stream verbatim to terminal stderr
after Elwood's required headless xterm render. It is a VT/ANSI terminal mirror,
not a line-oriented log: cursor-addressed repainting, alternate-screen buffers,
colors, cursor visibility, and other full-screen TUI control sequences MUST
remain intact. Raw frames remain excluded from stdout and from redirected
stderr because head mode requires that display channel to be a terminal.

Before launch, Elwood MUST size the agent PTY and headless terminal from the
headed terminal's positive integer columns and rows, falling back to the normal
Elwood terminal size for missing or invalid dimensions. During the run,
terminal resize events MUST resize both models through the public session
operation. Display writes MUST preserve order and honor backpressure. Because the
PTY producer cannot be paused at this boundary, Elwood MUST cap outstanding display
work at 4 MiB of UTF-8 data or 1,024 frames, whichever comes first. Crossing either
limit fails the run, stops accepting display frames, drains every already-accepted
byte in order, and performs the normal terminal restoration and cleanup before the
final nonzero result.

While attached, Elwood temporarily puts terminal stdin into raw mode and
discards ordinary keyboard, mouse, paste, and terminal-response bytes: v1 head
mode is observational, not interactive. Every Ctrl-C byte follows the same
first-interrupt/repeated-force-kill lifecycle as SIGINT. On every normal,
failure, timeout, or interruption outcome, Elwood MUST remove its input and
resize listeners, restore terminal stdin's prior raw/cooked mode, flush pending
display writes, reset attributes, disable mouse and bracketed-paste modes, show
the cursor, and leave the alternate screen before emitting the final stdout
protocol. `SIGKILL` cannot provide process-level terminal restoration. If the
host has already closed the terminal input handle, Elwood contains that handle's
terminal-gone error; the parent shell or terminal owner is then the only remaining
authority able to restore its modes, and that lost handle does not replace a
completed agent result with a runtime failure.

### 12A.7 Resume subcommand

`elwood resume <id> [options] [prompt...]` is an exact parse-time rewrite of
`elwood run --resume <id> [options] [prompt...]`. Both forms share one
resolution and execution path, so stored adapter and workspace loading, the
`--cwd` rejection, explicit-adapter conflicts, `--keep`, persona, `--ephemeral`,
and prompt composition from positional words plus piped stdin behave identically.
The first positional word is the session id and the remaining words are the
prompt. A missing id is a usage error, and supplying `--resume` together with
the subcommand is a usage error rather than a silent override.

### 12A.8 Session listing

`elwood sessions [--state-dir <path>] [--output <text|json>] [--no-defaults]`
lists the Elwood-owned session records under the effective CLI state directory,
resolved with the same flag, environment, config, and built-in precedence as a
run. It reads no prompt input and never launches an agent. Each listed record
reports the session id, adapter, stored workspace, `createdAt` (the session
directory's creation time) and `lastUsedAt` (the record's last write time) as
ISO-8601 UTC timestamps, `resumable` (whether the adapter's own conversation id
is stored), and `live` — whether a launch's bridge socket file is currently
present in the session's socket home. `live` is a cheap file-presence signal
with no side effects on a running owner: a socket left behind by a force-killed
process reads as live until that identity is next started or torn down. Records
are ordered by most recent use, then id. A record that is missing, unreadable,
or invalid under §12A.5 is skipped with one concise stderr warning and never
fails the listing; a state directory that does not exist yet is an empty listing.

Text output is an aligned table with a header row. An empty listing writes
nothing to stdout, one concise notice naming the state directory to stderr, and
exits 0. JSON output is exactly one version-1 document
`{ "schemaVersion": 1, "type": "sessions", "stateDir": "...", "sessions": [...] }`
whose array may be empty. JSONL is not a listing protocol; selecting it from any
source is a usage error that names the source. Any other run option or a
positional word is a usage error.

### 12A.9 Interactive mode

`elwood interactive [id] [options]` starts the selected agent's own interactive
CLI in the foreground of the caller's terminal with Elwood's resolved settings
passed as that CLI's native flags, then exits with the agent's exit status (128
plus the signal number when the agent is terminated by a signal). There is no
hidden PTY, headless terminal, hook bridge, readiness or turn detection, trust
automation, or stdout protocol: the agent inherits stdin, stdout, and stderr,
Elwood neither observes nor records the conversation, and no Elwood session
record is created, updated, or removed. Both stdin and stdout MUST be terminals;
otherwise the command fails before spawning with status 2. While the agent runs,
Elwood ignores `SIGINT` so Ctrl-C reaches the agent exactly as in a direct launch.

Agent selection, model, reasoning effort, workspace (`-C`), Claude permission
mode, and Codex sandbox and approval policy resolve with normal precedence,
validate against the effective adapter before spawning, and map through the same
launch-argument builder the adapters use (`claude --model`, `--effort`,
`--permission-mode`, `--allowedTools`, `--disallowedTools`, `--tools`; `codex
--model`, `--sandbox`, `--ask-for-approval`, `--cd`, and
`-c model_reasoning_effort=...`). The built-in non-interactive posture defaults
of §12A.2 are NOT applied: a posture flag reaches the agent only when a flag,
environment variable, config key, or stored record selected it, so an
unconfigured `elwood interactive` is the agent's own default experience. Trust
flags have no effect because the user answers the agent's dialogs directly.

With `[id]`, Elwood loads the stored record exactly as `--resume` does — the
stored adapter and workspace are used, `--cwd` is rejected, a conflicting
explicit adapter is a usage error, and the private-state constraints of §12A.5
apply — merges the stored launch posture with explicit posture options field by
field (the same rule as library resume), and hands the agent its own conversation
id (`claude --resume <conversation id>` or `codex resume <conversation id>`). A
record without a stored conversation id fails as `resume_unavailable`. Because
the agent owns the resumed conversation, later `elwood resume <id>` runs see
whatever the user said interactively.

`--output json`, `--output jsonl`, `--stream`, `--verbose`, `--debug`, `--head`,
`--timeout`, `--persona`, `--image`, `--keep`, `--show-session-id`, `--ephemeral`, and `--resume`
are usage errors with `interactive`, and more than one positional word is a usage
error. A launch that cannot spawn fails with the adapter's not-found error code
and status 1.

### 12A.10 Model listing

`elwood models [options] [--output <text|json>]` briefly starts a headless
session for each requested agent — honoring workspace, model, reasoning
effort, timeout, trust, state directory, and adapter posture with normal
precedence — waits for readiness, drives the agent's own model picker through
the public `listModels` operation (which opens and cancels the picker and leaves
the model unchanged), tears the session down, and exits 0. It sends no prompt,
runs no persona turn, uses a fresh session identity under the effective state
directory, and always tears that identity down, so no Elwood state remains
afterward. Starting the agent is unavoidable and the help text says so.

Without an explicit `--agent`, the command MUST probe Claude and then Codex
sequentially, regardless of `ELWOOD_AGENT` or a saved agent default. Each probe
uses its own adapter settings; adapter-specific flags and environment posture
settings apply only to their matching adapter. Shared settings apply to both.
`--timeout` is one budget for the whole command, including settings resolution
and preparation. Each probe receives only the remaining budget. Once exhausted,
the next adapter MUST NOT start; available catalogs remain in the partial result. A failed or unavailable adapter MUST NOT
hide the other adapter’s available models. SIGINT stops the command and MUST
NOT launch the next adapter. Every started probe is cleaned up before the next.

For combined listings, text includes an `AGENT` column and per-agent errors go
to stderr. JSON is exactly one document
`{ "schemaVersion": 1, "type": "models", "agents": [{ "agent": "...", "models": [...] }], "errors": [...] }`.
`agents` contains successful catalogs (including empty catalogs), and `errors`
contains the canonical version-1 error records with agent, error, duration, and
cleanup fields. Both arrays retain probe order. Status is 0 only if both probes
succeeded; otherwise interruption (130) takes precedence over timeout (124),
usage errors (2), and other failures (1). Output-protocol errors and global
config-file read, parse, or schema errors fail before any probe. Adapter-specific
setting validation failures are recorded for that adapter and permit the other
adapter to proceed. An explicit `--agent` preserves the single-agent output
and error contract below. All model probes remain ephemeral.

Single-agent text output is an aligned table with a header row: `*` in the first column marks
the current model, followed by the id, label, `(default)` when the row is the
adapter's default, and the description. JSON output is exactly one version-1
document `{ "schemaVersion": 1, "type": "models", "agent": "...", "models": [...] }`
whose rows are the `AgentModelOption` objects. Every string is sanitized under
§12A.3. Failures — timeout (124), interruption (130), blocked prompts, agent
exit, and picker automation failures — use the existing stderr, error-document,
and status conventions, and cleanup still runs exactly once. `--stream`,
`--head`, `--persona`, `--image`, `--keep`, `--show-session-id`, `--resume`, `--ephemeral`,
positional words, and JSONL output are usage errors.

Listing sessions resolves only state-directory and output settings. Adapter,
model, permission, trust, and turn-lifecycle environment defaults are irrelevant
and MUST NOT prevent listing. Config files still undergo strict schema decoding.
Interactive foreground launches MUST resolve the executable in the same
interactive login-shell environment used by auto-detection. If the shell exits
successfully without returning a complete PATH probe frame, the foreground
launch MUST preserve the inherited PATH. A complete frame containing an empty
PATH remains authoritative. C-CLI-24/25.
