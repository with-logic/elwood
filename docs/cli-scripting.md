# Elwood CLI Scripting Guide

Use an explicit output protocol in scripts. Elwood keeps stdout clean for the
selected text, JSON, or JSONL protocol; concise warnings and human diagnostics
use stderr.

## Quick start

```sh
elwood "Summarize this repository"
elwood run --output json < prompt.txt
git diff | elwood --agent claude --output json "Review this diff"
```

For a reproducible run, ignore saved Elwood defaults and choose the important
settings explicitly:

```sh
elwood --no-defaults \
  --agent codex \
  --output json \
  --timeout 10m \
  --codex-sandbox workspace-write \
  --codex-approval-policy never \
  "Run the tests and summarize failures"
```

`--no-defaults` ignores the user config and `ELWOOD_*` run-setting variables. It
does not strip the environment passed to Codex or Claude. To understand an
ordinary invocation before running it, use `elwood config effective` with the
same run-setting flags.

## JSON terminal documents

A successful `--output json` invocation emits exactly one document:

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

A failed turn still emits one parseable document and may retain partial response
text:

```json
{
  "schemaVersion": 1,
  "type": "error",
  "agent": "claude",
  "response": "I inspected the failing test before the agent exited.",
  "sessionId": null,
  "durationMs": 3102,
  "cleanup": { "action": "teardown", "status": "succeeded" },
  "error": {
    "code": "agent_exited",
    "message": "Agent exited before completing the turn."
  }
}
```

The `response` is every observed assistant text message in order, separated by
one blank line. It is not proof of success; inspect both the process exit status
and `type`.

## JSONL event records

`--output jsonl` emits normalized progress followed by exactly one terminal
`result` or `error`. Every record has an elapsed timestamp and sequence number.
Tool calls and results share `toolCallId` when the agent supplies one:

```jsonl
{"schemaVersion":1,"type":"status","status":"running","sequence":1,"elapsedMs":114}
{"schemaVersion":1,"type":"tool","phase":"call","name":"exec","content":"npm test","toolCallId":"call_7","sequence":2,"elapsedMs":827}
{"schemaVersion":1,"type":"tool","phase":"result","content":"12 tests passed","toolCallId":"call_7","sequence":3,"elapsedMs":2240}
{"schemaVersion":1,"type":"text","text":"All tests pass.","sequence":4,"elapsedMs":2620}
{"schemaVersion":1,"type":"result","agent":"codex","response":"All tests pass.","sessionId":null,"durationMs":2701,"cleanup":{"action":"teardown","status":"succeeded"},"sequence":5,"elapsedMs":2701}
```

JSONL warning records stay in stdout so the machine protocol remains ordered;
text and JSON runs surface warnings on stderr.

## Exit codes

| Status | Meaning |
| ---: | --- |
| `0` | Success, or the downstream consumer closed normally |
| `1` | Agent, runtime, or cleanup failure |
| `2` | Argument, configuration, workspace, or other usage failure |
| `124` | Invocation timeout |
| `130` | User interruption |

## Safe Bash and Zsh recipes

Enable pipeline failure propagation before piping directly into `jq`:

```sh
set -o pipefail
elwood --output json "Summarize this project" \
  | jq -er 'select(.type == "result") | .response'
```

Without `pipefail`, a successful `jq` can hide Elwood's nonzero status. For
maximum control—including access to a partial failure document—capture stdout in
a temporary file and preserve Elwood's exact status:

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

Do not use `jq -r .response` alone as a success check. Error documents can carry
a partial `response`, and streaming text can be partial when the process exits
nonzero.
