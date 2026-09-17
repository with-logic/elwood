# The `elwood` command

Purpose: the complete guide to the headless `elwood` executable, from a first
prompt to scripted JSON and JSONL pipelines.

## Basics

```sh
elwood "What's the weather today in Seattle?"
elwood --agent claude "Summarize this repository"
git diff | elwood "Review this diff and list only correctness risks"
elwood --image screenshot.png "Explain this failure"
elwood -C ../service --timeout 10m "Run the tests and diagnose failures"
elwood run --output json < prompt.txt
```

`elwood "prompt"` runs in the current directory, waits for one complete turn,
prints the combined assistant text to stdout, then stops the agent and preserves
its Elwood session state for later listing or resumption. Use `--ephemeral` to
remove that state afterward. It does not undo files the agent changed or remove history owned by
the agent CLI. `elwood run "prompt"` is the same command in explicit form.

Positional words are joined with spaces. Non-empty piped stdin is appended after
one blank line, so a short instruction can accompany a large document or diff.
Terminal stdin is not read. Repeat `--image` to attach multiple images in order.
Input is capped at 8 MiB. Durations accept positive integer `ms`, `s`, `m`, or
`h` values. Running `elwood` with no arguments prints the same text as
`elwood --help`; explicit `elwood run` still requires prompt input.

## Agent selection

Pick an agent with `--agent`, `ELWOOD_AGENT`, or the config `agent` key. When
nothing selects one, a new run auto-detects: Elwood tries `claude` first, then
`codex`, and uses the first whose command resolves in your login shell. It only
asks the shell `command -v`, so neither agent starts during detection.
`config effective` reports that choice with source `auto-detected`. If neither
resolves, the run fails before launch with `no_agent_found` (status 2) and a
message naming both agents and how to install or select one. Once an agent is
selected, Elwood never silently falls back to the other. Resume never probes;
it uses the stored agent.

## Defaults and configuration

`elwood config` manages one strict global JSON file. Project-local
configuration is deliberately unsupported, and global config is never loaded
from the repository being opened. The path is `$ELWOOD_CONFIG`, then an
absolute `$XDG_CONFIG_HOME/elwood/config.json`, then
`~/.config/elwood/config.json`:

```sh
elwood config path
elwood config show
elwood config effective
elwood config effective --agent claude --output json
elwood config set agent claude
elwood config set timeout 10m
elwood config get agent
elwood config unset timeout
```

Supported keys are `agent`, `output`, `timeout`, `trust`, `stateDir`,
`verbose`, `stream`, `persona`, `claude.model`, `claude.reasoningEffort`,
`claude.permissionMode`, `codex.model`, `codex.reasoningEffort`,
`codex.sandbox`, and `codex.approvalPolicy` (`schemaVersion` is always `1`).
Values are typed and unknown keys are rejected.

`config show` prints only the saved file. `config effective` validates and
prints the resolved launch and output values, the source of each, the config
path, and whether that file was loaded, without reading a prompt or starting an
agent. Its JSON includes `head` and, for Claude, the effective
`permissionMode`, `allowedTools`, `disallowedTools`, and `tools`; resume
inspection reports persisted tool rules with stored-session provenance.

Precedence is flags, environment, global config, then built-ins. `--no-stream`
and `--no-verbose` reverse inherited true values. `--no-defaults` ignores the
saved config and all `ELWOOD_*` run-setting variables for a reproducible
invocation; it does not strip the environment passed to the agent. Environment
names are `ELWOOD_AGENT`, `ELWOOD_OUTPUT`, `ELWOOD_TIMEOUT`, `ELWOOD_TRUST`,
`ELWOOD_STATE_DIR`, `ELWOOD_VERBOSE`, `ELWOOD_STREAM`, `ELWOOD_PERSONA`,
`ELWOOD_MODEL`, `ELWOOD_REASONING_EFFORT`, `ELWOOD_CLAUDE_PERMISSION_MODE`,
`ELWOOD_CODEX_SANDBOX`, `ELWOOD_CODEX_APPROVAL_POLICY`, and `ELWOOD_HIGH_TRUST`.
Boolean environment values are exactly `true` or `false`.

Run `elwood --help` for the full flag list. Launch controls include `--model`,
`--reasoning-effort`, `--persona`, `--claude-permission-mode`,
`--codex-sandbox`, `--codex-approval-policy`, `--state-dir`, `--verbose`,
`--debug`, and `--trust` / `--no-trust`. Live session warnings are quiet by
default; use `--verbose` or `--debug` to see them, including for `elwood models`.
The built-in non-interactive posture is Claude `dontAsk`, or Codex `workspace-write` with approval policy `never`.

For an unattended run that must never stop on a permission prompt, prefer the
agent-neutral `--high-trust` over per-agent posture flags. It selects Claude
`bypassPermissions`, or Codex `danger-full-access` with approval policy
`never`, for whichever agent runs. `ELWOOD_HIGH_TRUST=true` and `elwood config
set highTrust true` are the inherited forms, and `--no-high-trust` reverses
them. Combining it with `--claude-permission-mode`, `--codex-sandbox`, or
`--codex-approval-policy` in the same invocation is a usage error.

A reproducible run ignores saved defaults and states the important settings:

```sh
elwood --no-defaults \
  --agent codex \
  --output json \
  --timeout 10m \
  --codex-sandbox workspace-write \
  --codex-approval-policy never \
  "Run the tests and summarize failures"
```

## Output and pipelines

Text is the default output protocol. `--output json` emits one terminal
document, `--output jsonl` emits sequenced progress records, and `--stream`
prints assistant text as it arrives. Warnings and diagnostics go to stderr.
Field references, exit codes, and safe shell recipes are in
[cli-output.md](cli-output.md).

## Live terminal view

Add `--head` to watch the real agent interface while keeping a
pipeline-friendly final result:

```sh
elwood --head "Run the test suite and fix the failure"
elwood --head --output json "Review this repository" >result.json
```

The display receives the raw PTY byte stream on stderr. It is a real VT/ANSI
mirror, so full-screen layouts, cursor-addressed updates, alternate-screen
buffers, colors, spinners, and title changes render as they do in the
underlying client. Stdout remains only the final text or JSON protocol. Pending
display work is capped at 4 MiB or 1,024 writes; a terminal that stays
backpressured fails the run cleanly instead of growing memory without bound.

Head mode is view-only: keyboard, mouse, paste, and terminal-response bytes are
discarded while attached. Ctrl-C still interrupts. Terminal resizes propagate to
the agent. Elwood restores raw/cooked input state, mouse and paste modes,
attributes, cursor visibility, and the main screen before printing the final
result. Both stdin and stderr must be terminals, and `--head` cannot be
combined with `--stream`, `--verbose`, `--debug`, or `--output jsonl`.

## Continuation and cleanup

New and resumed runs preserve state by default; `--keep` explicitly selects
that default. A retained text run reports its session ID on stderr; JSON and
JSONL include it in the terminal record:

```sh
first=$(elwood --output json "Remember that the release color is teal")
id=$(printf '%s' "$first" | jq -r .sessionId)
elwood --resume "$id" "What is the release color?"
elwood --resume "$id" --ephemeral "Finish this conversation"
```

Resume uses the exact stored agent and workspace; a conflicting `--agent` and
any `--cwd` are rejected. Resumed sessions stay preserved after success or
failure unless `--ephemeral` requests teardown. Teardown removes Elwood's
session record and loop definitions; it does not undo workspace changes or
delete conversation history owned by Claude or Codex. CLI state defaults to an
absolute `$XDG_STATE_HOME/elwood` or `~/.local/state/elwood`; its private
records hold resume metadata, not prompts or output.

`--persona` runs a real extra agent turn before the requested turn. Elwood
discards that setup turn's answer, but any tools it invokes or files it changes
remain. It is supported only for new sessions, never with `--resume`.

## Trust and security

Headless mode is non-interactive. With the default `--trust`, Elwood answers
only its allowlisted workspace-directory and extension trust dialogs.
`--no-trust` disables those approvals. Codex hook trust is always bypassed for
the entire session, including third-party hooks configured in Codex, because
Elwood needs its own hook bridge to run. This bypass is independent of `--trust`.
Other recognized dialogs fail as `blocked_prompt`. The same error applies when
safe trust automation cannot clear a gate within five seconds; queued prompt
input is never sent into that gate.

Piped text and image paths are prompt input with the same authority as text
typed by the caller. Do not combine untrusted input with broad filesystem
permissions.

Head mode renders agent-controlled terminal escape sequences verbatim, exactly
as running the interactive CLI directly would. Use it only with agents and
workspaces you trust to control the current terminal display.
