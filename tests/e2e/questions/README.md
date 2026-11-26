# Native question proof and capture helpers

The public API round trips are documented in
[`docs/native-question-proofs.md`](../../../docs/native-question-proofs.md).
`proof-files.ts` keeps captures private and reads only committed transcript rows.

The commands below are direct-PTY smoke/characterization runs independent of
Elwood's question adapter. They print captured screen names and discard the
captures on exit; they do not regenerate fixture files. Each command uses one
valid-model turn against the pinned Codex 0.172.0 binary and synthetic questions:

```sh
node --no-warnings --input-type=module -e 'const { captureNativeCodexAsyncQuestions } = await import("./tests/e2e/questions/codex-capture.ts"); const capture = await captureNativeCodexAsyncQuestions(); console.log(Object.keys(capture.screens));'
node --no-warnings --input-type=module -e 'const { captureNativeCodexModalQuestions } = await import("./tests/e2e/questions/codex-capture.ts"); const capture = await captureNativeCodexModalQuestions(); console.log(Object.keys(capture.screens));'
```

Before the model prompt, the direct driver requires a native response to the
local `/pwd` command and a cleared composer. The cold placeholder alone does
not prove that the input loop accepted a command.

The returned capture contains native screens, physical writes and committed
records for comparison with the 0.163.0 captures in
`tests/fixtures/codex-0.163.0/questions/` and the 0.172.0 ones in
`tests/fixtures/codex-0.172.0/questions/`. 0.172.0 parks its hidden cursor and
shows pending answers differently; see "Codex 0.172.0 Plan mode and queued
choices" in `docs/cli-behavior.md`. These are
maintainer characterization tools; they do not prove the public answer API.
The owned dependent public proofs are `tests/e2e/codex-questions.e2e.ts`
(C-E2E-19), `tests/e2e/codex-question-turn-end.e2e.ts` (C-ATTN-02) and
`tests/e2e/codex-question-narrow.e2e.ts` (C-QUESTION-04), documented in the
consumer proof guide above. Run those entrypoints separately to verify public
discovery, answering, native acceptance, and closure.
`nativeCodexQuestionSandbox()` also supplies the isolated PTY for deeper cursor
and cell-style probes. Its caller must await `dispose()` in a `finally` block.
All sandboxes remove private homes and verify parent configuration is unchanged.
Do not persist credentials or unsanitized transcript records in fixtures.
