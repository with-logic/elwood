# `elwood` output protocols and scripting

Purpose: field-level reference for the text, JSON, and JSONL output protocols,
exit codes, and safe shell recipes. Start with [cli.md](cli.md) for usage.

## Text, verbose, and stream

Text is the default output protocol. Warnings and diagnostics go to stderr,
never into the answer on stdout. `--verbose` adds compact elapsed phase,
tool-name, warning, and cleanup progress; it does not repeat assistant or
thinking text. `--debug` adds full sanitized event details. `--stream` emits
assistant text as it arrives and is valid only with text output; use
`--no-stream` when config enabled streaming but a script needs JSON.

```sh
answer=$(elwood "Name the primary package in this repository")
elwood --output jsonl "Run the tests" | jq -c 'select(.type == "tool")'
elwood --stream --verbose "Implement the smallest safe fix"
```

ANSI terminal frames, raw hook payloads, screen contents, bridge credentials,
and stacks are excluded from production output. Writes honor backpressure, and
a downstream pipe closing early triggers cleanup without an uncaught `EPIPE`.

## JSON terminal documents

`--output json` emits exactly one version-1 document. Its stable fields are
`schemaVersion`, `type`, `agent`, `response`, `sessionId`, `durationMs`,
`cleanup`, and, on failure, `error`:

```json
{
  "schemaVersion": 1,
  "type": "result",
  "agent": "codex",
  "response": "The tests pass.",
  "sessionId": null,
  "durationMs": 8421,
  "cleanup": { "action": "teardown", "status": "succeeded" }
}
```

A failed turn still emits one parseable document and may retain partial
response text:

```json
{
  "schemaVersion": 1,
  "type": "error",
  "agent": "claude",
  "response": "I inspected the failing test before the agent exited.",
  "sessionId": null,
  "durationMs": 3102,
  "cleanup": { "action": "teardown", "status": "succeeded" },
  "error": { "code": "agent_exited", "message": "Agent exited before completing the turn." }
}
```

`response` is every observed assistant text message in order, separated by one
blank line. It is not proof of success; inspect both the process exit status
and `type`. An error record emitted before an agent was selected (for example
a usage error or `no_agent_found`) reports `"agent": null`.

## JSONL event records

`--output jsonl` emits sequenced version-1 `text`, `thinking`, `tool`,
`status`, and `warning` records followed by exactly one `result` or `error`
record. Every record has `sequence` and `elapsedMs`; tool calls and results
share `toolCallId` when the agent supplies one:

```jsonl
{"schemaVersion":1,"type":"status","status":"running","sequence":1,"elapsedMs":114}
{"schemaVersion":1,"type":"tool","phase":"call","name":"exec","content":"npm test","toolCallId":"call_7","sequence":2,"elapsedMs":827}
{"schemaVersion":1,"type":"tool","phase":"result","content":"12 tests passed","toolCallId":"call_7","sequence":3,"elapsedMs":2240}
{"schemaVersion":1,"type":"text","text":"All tests pass.","sequence":4,"elapsedMs":2620}
{"schemaVersion":1,"type":"result","agent":"codex","response":"All tests pass.","sessionId":null,"durationMs":2701,"cleanup":{"action":"teardown","status":"succeeded"},"sequence":5,"elapsedMs":2701}
```

JSONL warning records stay on stdout so the machine protocol remains ordered;
text and JSON runs surface warnings on stderr.

## Exit codes

| Status | Meaning |
| ---: | --- |
| `0` | Success, or the downstream consumer closed normally |
| `1` | Agent, runtime, or cleanup failure |
| `2` | Argument, configuration, workspace, or other usage failure, including `no_agent_found` |
| `124` | Invocation timeout |
| `130` | User interruption |

The first Ctrl-C requests a clean interrupt; a repeated Ctrl-C force-kills
before cleanup.

## Safe Bash and Zsh recipes

Enable pipeline failure propagation before piping into `jq`; without it a
successful `jq` hides Elwood's nonzero status:

```sh
set -o pipefail
elwood --output json "Summarize this project" \
  | jq -er 'select(.type == "result") | .response'
```

For access to a partial failure document, capture stdout in a temporary file
and preserve Elwood's exact status:

```sh
result_file=$(mktemp)
trap 'rm -f "$result_file"' EXIT

if elwood --output json "Run the release checks" >"$result_file"; then
  jq -er 'select(.type == "result") | .response' <"$result_file"
else
  elwood_status=$?
  jq -r '"elwood: \(.error.code): \(.error.message)"' <"$result_file" >&2
  exit "$elwood_status"
fi
```

Do not use `jq -r .response` alone as a success check. Error documents can
carry a partial `response`, and streamed text can be partial when the process
exits nonzero.
