# Native question proof and capture helpers

The public API round trips are documented in
[`docs/native-question-proofs.md`](../../../docs/native-question-proofs.md).
`proof-files.ts` keeps captures private and reads only committed transcript rows.

The commands below are direct-PTY smoke/characterization runs independent of
Elwood's question adapter. They print captured screen names and discard the
captures on exit; they do not regenerate fixture files. Each command uses one
valid-model turn against the pinned Codex 0.163.0 binary and synthetic questions:

```sh
node --no-warnings --input-type=module -e 'const { captureNativeCodexAsyncQuestions } = await import("./tests/e2e/questions/codex-capture.ts"); const capture = await captureNativeCodexAsyncQuestions(); console.log(Object.keys(capture.screens));'
node --no-warnings --input-type=module -e 'const { captureNativeCodexModalQuestions } = await import("./tests/e2e/questions/codex-capture.ts"); const capture = await captureNativeCodexModalQuestions(); console.log(Object.keys(capture.screens));'
```

Before the model prompt, the direct driver requires a native response to the
local `/pwd` command and a cleared composer. The cold placeholder alone does
not prove that the input loop accepted a command.

The returned capture contains native screens, physical writes and committed
records for comparison with `tests/fixtures/codex-0.163.0/questions/`. These are
maintainer characterization tools; they do not prove the public answer API.
The owned dependent public proof is `tests/e2e/codex-questions.e2e.ts`
(C-E2E-19), documented in the consumer proof guide above. Run that entrypoint
separately to verify public discovery, answering, native acceptance, and closure.
`nativeCodexQuestionSandbox()` also supplies the isolated PTY for deeper cursor
and cell-style probes. Its caller must await `dispose()` in a `finally` block.
All sandboxes remove private homes and verify parent configuration is unchanged.
Do not persist credentials or unsanitized transcript records in fixtures.
