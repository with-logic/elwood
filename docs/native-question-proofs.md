# Native question proofs

These opt-in tests exercise `listQuestions()` and `answerQuestions()` against
real authenticated CLI processes. Each entrypoint uses two valid-model turns.
Run them separately after `npm run check`; they consume model quota.

## Claude: C-E2E-18

```sh
ELWOOD_NATIVE_QUESTIONS_PROOF=1 node --no-warnings --test --test-concurrency=1 tests/e2e/claude-questions.e2e.ts
```

The proof pins Claude Code 2.1.305 and uses `haiku`. It prefers that exact binary
in `~/.local/share/claude/versions/`, falling back to the installed binary only
when its version matches. It copies credentials into a private temporary home
and writes a minimal temporary configuration. Parent configuration is checked
for changes; it is not copied into the proof's home. The parent CLI installation
remains unchanged.

The first turn submits grouped single and multiple choices. The second submits
multiline alternative text. Both compare the native `AskUserQuestion`
PostToolUse answers, require an answered closure and an empty pending list,
and keep the original `send()` waiting for the final assistant reply.

Question events and normalized activities must correspond exactly and contain
no submitted answer marker. The proof recursively checks Elwood-owned state
before and after shutdown. Diagnostic artifacts use private, exclusive files
inside the sandbox. Teardown removes the sandbox and verifies that parent
configuration, authentication and process environment remain unchanged.

## Codex: C-E2E-19

```sh
ELWOOD_NATIVE_QUESTIONS_PROOF=1 node --no-warnings --test --test-concurrency=1 tests/e2e/codex-questions.e2e.ts
```

The proof pins Codex 0.163.0 and uses `gpt-6-luna` with low effort. The first
turn asks three queued questions in one asynchronous call. It answers Note,
Literal, then Color through the public API, checking the other requests remain
available and the original turn remains running. The second turn submits one
three-question Plan modal, including None of the above and a named choice with
additional notes.

Both long answers exceed 700 characters and include CRLF and CR line endings,
interior tabs, indented caret rows, interior trailing spaces and outer Unicode
whitespace. Complete committed native free-text answers and notes must match
after newline normalization and outer Unicode White_Space trimming. Queued
selected labels are trimmed; modal selected labels remain exact (PRD §5.10).
The literal answers
`Type your answer` and `Add notes` must also match exactly; a clipped viewport
or placeholder rendering is not accepted as proof of the submitted value.

The proof compares complete queued reply envelopes and grouped modal answer
arrays, requires four answered request closures and final-only ergonomic
replies, and applies the same telemetry/state privacy and parent-state checks
as the Claude proof. Native transcripts and diagnostic captures stay inside
private sandbox directories that teardown removes.
