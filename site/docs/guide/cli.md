# The CLI

The `elwood` command runs one agent turn, writes the reply, and exits. It still drives the real interactive agent under the hood. You get a shell-friendly interface without scraping its screen.

```sh
elwood "Summarize this repository."
```

`elwood run` is the explicit form of the same command. With no arguments, `elwood` prints help. Without an explicit agent choice, Elwood tries Claude first, then Codex. You can [save a default](configuration.html).

## Input

Positional words become the prompt. Piped input is appended after a blank line:

```sh
git diff | elwood "Review this diff for correctness."
elwood run < prompt.txt
elwood -C ../service "Explain the entry point."
elwood --image screenshot.png "What looks wrong?"
```

Repeat `--image` for multiple images. Input is limited to 8 MiB. The command does not read interactive terminal stdin as a prompt.

## Output formats

| Format | Use it for | Behavior |
| --- | --- | --- |
| `--output text` | A person or a text file | Combined assistant reply; default |
| `--output json` | A script that needs one result | One terminal document with response, status and cleanup |
| `--output jsonl` | Progress in another program | Ordered event records, then one result or error |

Text output contains only the agent response by default. Add `--show-session-id`
to print the retained session ID on stderr, or find it later with `elwood sessions`.

Text errors use stderr; JSON errors are emitted as terminal records on stdout. Routine session warnings are quiet unless `--verbose` or `--debug` is enabled. JSONL includes warning records in its ordered stdout stream. A response can contain useful partial text even when the run fails: inspect the exit code and terminal record type.

```sh
elwood --output json "Describe the architecture."
```

Illustrative successful output:

```json
{
  "schemaVersion": 1,
  "type": "result",
  "agent": "claude",
  "response": "The project has a CLI, a session layer, and two adapters.",
  "sessionId": "example-session-id",
  "durationMs": 8421,
  "cleanup": { "action": "preserve", "status": "succeeded" }
}
```

`response` combines all observed assistant text in order. `sessionId` is null for a new ephemeral session. Failure documents use `type: "error"` and add `error.code` and `error.message`. [See output records and exit codes](cli-reference.html#output-records).

## Streaming and verbose output

```sh
elwood --stream --verbose "Explain the build pipeline."
```

`--stream` emits assistant text as it arrives. `--verbose` prints concise elapsed progress and session warnings to stderr. Streaming is valid only with text output; use `--no-stream` if a saved setting enables it and you need JSON.

To see the actual TUI, use `--head`:

```sh
elwood --head "Explain the architecture."
```

Head mode is view-only. It requires terminal stdin and stderr and cannot combine with stream, verbose, debug or JSONL. Ctrl-C still interrupts. It mirrors terminal bytes to stderr while the final reply remains on stdout.

## Timeouts

```sh
elwood --timeout 2m "List the main modules."
```

CLI timeout covers launch, any persona setup turn and the requested turn. Durations use a positive integer plus `ms`, `s`, `m` or `h`. There is no default whole-invocation timeout. A timeout exits with status 124.

## Resuming a session

New and resumed runs preserve their Elwood state by default so a later process can resume. `--keep` explicitly selects this default; `--ephemeral` removes Elwood state after either a new or resumed run. With text output, `--show-session-id` opts into the session ID on stderr; JSON includes it in the result.

This Bash/Zsh example requires `jq`:

```sh
first=$(elwood --output json \
  "Remember: this release is called Acorn.") || exit $?

session_id=$(printf '%s' "$first" \
  | jq -er 'select(.type == "result") | .sessionId') || exit $?

elwood resume "$session_id" "What is the release called?"
elwood resume "$session_id" --ephemeral "Finish with a one-line summary."
```

`elwood resume <id>` is the subcommand form of `--resume <id>`; the two are the same run. Resume uses the stored agent and workspace. Do not add `--cwd` or a conflicting `--agent`. Resumed sessions stay preserved unless you pass `--ephemeral`. Cleanup removes Elwood metadata and loop definitions; workspace edits and the agent's own history remain.

## Listing sessions

`elwood sessions` lists the session records Elwood owns in the effective state directory. It never starts an agent.

```sh
elwood sessions
elwood sessions --output json
```

Each record reports its id, agent, workspace, creation and last-used times, whether it is resumable, and whether it is live (a launch's bridge socket is present). JSON emits one `{"schemaVersion": 1, "type": "sessions", ...}` document. An empty state directory is a normal, empty result.

## Listing models

`elwood models` probes Claude then Codex and notes the agent beside each model. Each probe briefly opens and cancels its model picker, then removes its session state. Your configured models stay unchanged. Use `--agent` to list only one adapter; environment and saved agent defaults do not narrow the bare command.

```sh
elwood models
elwood models --agent codex --output json
```

Text marks the current model with `*` and the default with `(default)`. JSON emits one `{"schemaVersion": 1, "type": "models", ...}` document. Combined listings have `agents: [{agent, models}]` and `errors: [...]`; explicit `--agent` retains `agent` and `models`. Rows carry `id`, `label`, `description`, `isCurrent`, and `isDefault`.

If one adapter fails or is unavailable, the available catalog is still returned with per-agent errors and a nonzero exit status. `--timeout` is a whole-command budget shared by both probes. Ctrl-C stops further probes. Each probe uses its matching adapter settings.

## The agent's own terminal

`elwood interactive` hands your terminal to the real agent TUI, exactly as running `claude` or `codex` yourself would, but with Elwood's resolved settings passed as the agent's own flags.

```sh
elwood interactive
elwood interactive --agent codex --model gpt-5.4
elwood interactive "$session_id"
```

With an id, the stored session's conversation reopens in its stored workspace with its stored posture. Elwood does not observe or record an interactive conversation and writes no session state. It requires a terminal on stdin and stdout, and cannot be combined with `--output json`/`jsonl`, `--stream`, `--verbose`, `--debug`, `--head`, `--timeout`, `--persona`, `--image`, `--keep`, `--ephemeral`, or `--resume`.

## Reproducible runs

```sh
elwood --no-defaults --agent claude \
  --output json --timeout 2m \
  --claude-permission-mode dontAsk \
  "Explain this project's directory structure."
```

`--no-defaults` ignores saved Elwood defaults and its `ELWOOD_*` run-setting environment variables. It leaves the selected agent's normal process environment intact. [Inspect configuration precedence](configuration.html).
