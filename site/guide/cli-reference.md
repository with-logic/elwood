# CLI reference

The executable is `elwood`, installed by `@with-logic/elwood`. `run` is the default command. Use `config --help` for configuration commands.

## Command help

The following flag list is synchronized from the library's first-party CLI help when this guide is built.

```text
Usage: elwood [options] [prompt...]
       elwood run [options] [prompt...]
       elwood resume <id> [options] [prompt...]
       elwood interactive [id] [options]
       elwood sessions [--state-dir <path>] [--output <text|json>]
       elwood models [options] [--output <text|json>]
       elwood config <command>

Run one Claude Code or Codex turn and write its combined assistant response.
Positional text and piped stdin are combined with one blank line.

Examples:
  elwood "Summarize this repository"
  git diff | elwood "Review this diff for correctness"
  elwood run --output json < prompt.txt
  elwood --output json "Remember this decision"

Commands:
  run                         Run one agent turn (default)
  resume <id> [prompt...]     Resume a kept session; same as run --resume <id>
  interactive [id]            Open the agent's own TUI here with Elwood's settings
  sessions                    List Elwood-owned session records; never starts an agent
  models                      List both agents' models (starts each briefly)
  config                      Inspect or update global defaults; see config --help
  help                        Show this help

Agent and turn options:
  --agent <claude|codex>      Select the agent (default: first available of claude, codex)
  --model <id>                Select or switch the model
  --reasoning-effort <level>  Claude: low|medium|high|xhigh|max
                              Codex: none|minimal|low|medium|high|xhigh|max
  --persona <prompt>          Run a real side-effect-capable setup turn; hide its answer
  -C, --cwd <path>            Workspace for a new run (default: current directory)
  --image <path>              Attach an image; repeat to preserve order
  --timeout <duration>        Bound launch, setup, and turn (default: none; ms|s|m|h)
  --trust / --no-trust        Toggle allowlisted trust automation (default: trust)
  --no-defaults               Ignore saved config and ELWOOD_* run defaults

Continuation and output:
  --keep                      Preserve Elwood state (default)
  --show-session-id           Print the retained session ID on stderr (default: off)
  --resume <id>               Resume the exact stored agent and workspace
  --ephemeral                 Remove new or resumed Elwood state afterward
  --output <text|json|jsonl>  Stdout protocol (default: text)
  --stream / --no-stream      Toggle incremental text output (default: off)
  --verbose / --no-verbose    Toggle warnings and concise progress on stderr (default: off)
  --debug                     Write full sanitized event details to stderr
  --head                      View the full agent TUI in this terminal
  --state-dir <path>          Override CLI-owned state storage

Agent posture defaults and supported values:
  --high-trust / --no-high-trust
                              Never ask for permissions on either agent (default: off):
                              Claude bypassPermissions; Codex danger-full-access + never
  --claude-permission-mode <default|acceptEdits|plan|auto|dontAsk|bypassPermissions>
                              Default: dontAsk
  --codex-sandbox <read-only|workspace-write|danger-full-access>
                              Default: workspace-write
  --codex-approval-policy <untrusted|on-request|never>
                              Default: never

Head mode is view-only and requires terminal stdin and stderr. It cannot be
combined with stream, verbose, debug, or JSONL output. Ctrl-C still interrupts.

Warnings and diagnostics use stderr; stdout remains the selected protocol.
Use "elwood config effective" to explain resolved values and their sources.

Resume subcommand:
  elwood resume <id> [prompt...] is exactly elwood run --resume <id>: the stored
  agent and workspace are used, --cwd is rejected, and piped stdin still applies.

Interactive mode:
  elwood interactive [id] runs claude or codex in the foreground of this terminal
  with the resolved agent, model, effort, workspace, and posture passed as the
  agent's own flags. Elwood does not observe or record the conversation and
  writes no session state. With an id, the stored session's own conversation is
  resumed in its stored workspace with its stored posture. Requires a terminal on
  stdin and stdout; cannot be combined with --output json/jsonl, --stream,
  --verbose, --debug, --head, --timeout, --persona, --image, --keep, --show-session-id, --ephemeral,
  or --resume. Built-in posture defaults are not applied unless configured.

Session listing:
  elwood sessions lists id, agent, live, resumable, last used, created, and
  workspace for records in the effective state directory. "live" means a
  launch's bridge socket is present. Text is an aligned table; --output json
  emits one {"schemaVersion":1,"type":"sessions",...} document. An empty state
  directory is a normal, empty result.

Model listing:
  elwood models probes Claude then Codex, showing each model's agent. --agent
  limits the listing to that agent; saved/environment agent defaults do not.
  Each probe opens and cancels the picker, then removes its session state.
  Text marks current with * and default with (default); JSON emits one models
  document: agents/errors arrays for both, or agent/models with --agent.
  Partial failures retain available models and exit nonzero. --timeout is one
  budget for the whole command; Ctrl-C stops further probes. Honors --cwd,
  --model, --reasoning-effort, --state-dir, trust, and matching posture flags.

  -h, --help                  Show this help
  -V, --version               Show the Elwood version
```

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

```text
Usage: elwood config <command> [arguments]

Inspect or update Elwood's global user configuration without starting an agent.

Commands:
  path                        Print the global config path
  show                        Print the saved configuration document
  effective [run options]     Explain resolved launch/output settings and sources
  get <key>                   Print one configured scalar
  set <key> <value>           Set one documented config key
  unset <key>                 Remove one configured key

  -h, --help                  Show this help

Examples:
  elwood config show
  elwood config effective --agent claude
  elwood config set codex.sandbox workspace-write
```

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
