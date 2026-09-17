# CLI reference

The executable is `elwood`, installed by `@with-logic/elwood`. `run` is the default command. Use `config --help` for configuration commands.

## Command help

The following flag list is synchronized from the library's first-party CLI help when this guide is built.

<!-- CLI_HELP -->

## Output records

JSON terminal records have `schemaVersion: 1`, `type`, `agent`, `response`, `sessionId`, `durationMs`, and `cleanup`. Error records add `error: { code, message }`. `cleanup.action` is `none`, `preserve` or `teardown`; `cleanup.status` is `succeeded` or `failed`, with an optional error message.

`elwood sessions` and `elwood models` emit their own single documents, `{"schemaVersion": 1, "type": "sessions", ...}` and `{"schemaVersion": 1, "type": "models", ...}`. Both accept `--output text` (the default) or `--output json`; JSONL is not a listing protocol. Bare `models` includes `agents: [{agent, models}]` and `errors: [...]` for Claude and Codex; explicit `--agent` retains `agent` and `models`. Incomplete catalogs exit nonzero, and `--timeout` is shared by both probes.

JSONL records add a monotonically increasing `sequence` and elapsed `elapsedMs`. Progress record types are `text`, `thinking`, `tool`, `status` and `warning`. A tool record has `phase: "call"` or `"result"`, optional content and a shared `toolCallId` when available. Exactly one terminal `result` or `error` ends the stream.

Do not treat `response` alone as proof of success. Inspect both the process status and terminal record type.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success, or a downstream consumer closed normally |
| `1` | Agent, runtime or cleanup failure |
| `2` | Usage, configuration or workspace failure |
| `124` | Invocation timeout |
| `130` | User interruption |

## Configuration commands

<!-- CONFIG_HELP -->

## Combinations to know

- `--stream` works with text output only. Use `--no-stream` to override saved streaming before requesting JSON.
- `--head` requires terminal stdin and stderr. It cannot combine with stream, verbose, debug or JSONL. It is view-only; Ctrl-C still interrupts.
- `--resume` restores the stored agent and workspace. Any `--cwd` or conflicting `--agent` is invalid.
- `--persona` performs a real setup turn for new sessions and cannot be used with resume.
- `--ephemeral` removes new or resumed Elwood state afterward. Both preserve state by default; explicit `--keep` and `--ephemeral` cannot be combined.
- `--high-trust` cannot combine with an explicit `--claude-permission-mode`, `--codex-sandbox` or `--codex-approval-policy`. Use `--no-high-trust` to reverse an inherited value.
- `elwood interactive` needs a terminal and rejects the scripted flags (`--output json`/`jsonl`, `--stream`, `--verbose`, `--debug`, `--head`, `--timeout`, `--persona`, `--image`, `--keep`, `--ephemeral`, `--resume`).
- `elwood sessions` never starts an agent; `elwood models` probes Claude then Codex (or only the explicit `--agent`) and leaves no session state behind.

Flags override environment, which overrides global configuration, which overrides built-ins. [See all configuration keys](configuration.html).
