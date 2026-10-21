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
