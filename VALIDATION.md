# Review Validation

Verdict: fail

## Summary

- Total findings: 13
- Addressed: 7
- Partially addressed: 6
- Not addressed: 0
- Cannot verify: 0

## Findings

### partially addressed: The repository now has mutually exclusive conformance requirements

- Original: blocker at `PRD.md:277-279`, `PRD.md:358-359`, `PRD.md:946-954`, `PRD.md:1271-1273`, `PRD.md:1302-1303`, `PRD.md:1504-1511`, `PRD.md:2062-2066`, `PRD.md:2092-2100`, `PRD.md:2309`, `README.md:613-614`, and contradictory entries in `CHANGELOG.md`.
- Evidence: The central state contract and consumer documentation are now consistent about the exact minimal record and live-only warnings at `PRD.md:1907-1930` and `README.md:599-623`. However, `PRD.md:2050-2053` still places an “early-warning flush,” including a possible disk/permission failure, inside the pre-return startup cleanup boundary, while `PRD.md:2305` requires the preflight warning to be delivered after `startClaude`/`startCodex` resolves. `CHANGELOG.md:21-23` also says each lost record is one warning, while the current implementation deliberately coalesces records per scan at `src/core/transcript/drops.ts:38-76`. The retained Codex `name` option remains declared at `PRD.md:1154-1170` and `src/codex/session-types.ts:32-48` without defined behavior.
- Verification: Traced the current PRD, README, changelog, public option types, and startup/warning implementation; `npm run typecheck`, `npm run lint`, and `npm run check:lines` passed.
- Rationale: Most of the original contract sweep was completed, including terminal size, warning snapshots, status, runtime paths, credentials, and reap warnings. The remaining startup-warning contradiction and warning-cardinality mismatch mean the contract is still not fully self-consistent.

### partially addressed: Source documentation still describes removed persistence paths

- Original: major at `src/runtime/session-reap.ts:2-6`, `src/core/activity-lifecycle.ts:36-43`, `src/claude/transcript/warnings.ts:1-5`, `src/claude/transcript/warnings.ts:42-46`, `src/codex/transcript/warnings.ts:29-33`, `src/claude/login-expired.ts:15-29`, `src/claude/resize-restore.ts:1-8`, `src/runtime/session-base.ts:161`, `src/runtime/session-base.ts:180-182`, `src/runtime/status-emit.ts:3-7`, and `src/core/status-categories.ts:2-6`.
- Evidence: Many cited comments are corrected, including `src/claude/transcript/warnings.ts:2-8`, `src/claude/resize-restore.ts:2-9`, `src/runtime/session-base.ts:161-168`, and `src/runtime/status-emit.ts:2-8`. Stale persistence language remains at `src/runtime/session-reap.ts:34` (“durable warning”), `src/core/status-categories.ts:25` (“persisted status”), and `src/claude/session-instance.ts:140-145` (“durable record”). `src/runtime/startup-cleanup.ts:76-81` likewise still describes a disk error in a warning flush.
- Verification: Repository-wide targeted `rg` searches for persistence, durability, replay, record, aggregate, and count terminology were traced against the current code; Biome passed.
- Rationale: The majority of the original comments were repaired, but several current comments still state persistence semantics that the implementation and PRD explicitly removed.

### addressed: Live-only emitters retain persistence-oriented names

- Original: minor at `src/runtime/session-base.ts:168`, `src/codex/session-instance.ts:179-180`, `src/core/transcript/drops.ts:31-32`, and `src/core/transcript/drops.ts:55-56`.
- Evidence: The session abstraction now uses `emitWarnings` at `src/runtime/session-base.ts:161-168`; Codex uses `emitCodexWarnings` at `src/codex/session-warnings.ts:11-20`; transcript diagnostics use `DropReporter` and `ReadErrorReporter` at `src/core/transcript/drops.ts:38-44` and `src/core/transcript/drops.ts:80-81`.
- Verification: Targeted symbol search found no current `recordWarnings`, `recordCodexWarnings`, `DropTracker`, or `ReadErrorTracker`; `npm run typecheck` passed.
- Rationale: The persistence-oriented names were replaced consistently across source and tests with names describing live emission/reporting.

### addressed: Cleanup helpers take ambiguous adjacent string arguments

- Original: minor at `src/state/runtime-paths.ts:32-36` and `src/state/store.ts:105`.
- Evidence: `sessionRuntime` accepts the named `SessionRuntimeInput` object at `src/state/runtime-paths.ts:27-42`; `removeSessionFiles` accepts `RemoveSessionFilesInput` at `src/state/store.ts:104-116`; the teardown call supplies named fields at `src/runtime/session-shutdown.ts:150-155`.
- Verification: The focused non-socket Vitest run passed `tests/unit/state-store.test.ts` and `tests/unit/state-store-edges.test.ts` as part of 53 passing tests; typecheck passed.
- Rationale: The adjacent positional strings were removed, all current callers use named fields, and focused state-store coverage exercises the new API.

### partially addressed: Legacy schema-v1 fields cross the validation boundary and are persisted again

- Original: blocker at `src/state/store.ts:23-30`, `src/state/store.ts:72-80`, `src/state/store.ts:96-101`, and `src/state/validate.ts:12-20`.
- Evidence: `validateSessionRecord` now constructs a fresh allowlisted top-level record at `src/state/validate.ts:13-30`, and `adapterState` constructs fresh `{resumeId, launch}` state at `src/state/validate.ts:32-45`. A direct legacy-record probe seeded retired top-level and adapter keys, updated the resume id, wrote the result, and observed only `adapter`, `claude`, `codex`, `cwd`, `elwoodSessionId`, and `schemaVersion`. However, `tests/unit/state-validate.test.ts:15-86` has no case seeding removed top-level/adapter keys, and `tests/unit/state-store.test.ts:56-85` only checks a newly created minimal record.
- Verification: Focused state tests passed; the direct canonicalization probe reported `topLevelRetired:false` and `adapterRetired:false`.
- Rationale: The implementation now fixes the data-retention failure mode, including the old schema-v1 path, but the requested focused regression test for a legacy record is absent. A future return of the original spread/round-trip bug would not be caught by the present repository tests.

### partially addressed: No adapter-level test protects the no-late-replay warning contract

- Original: minor at `tests/unit/session-warnings.test.ts:35-45`.
- Evidence: Warning subscriptions replay only terminal data, not warnings, at `src/runtime/session-base.ts:169-171`. Codex has the complete late-subscriber regression sequence at `tests/codex/session-warning-contract.test.ts:65-88`. Claude asserts that the old preflight warning is not replayed at `tests/claude/session-warning-contract.test.ts:72-86`, but despite the test title it never emits a subsequent warning to prove the newly attached listener still works and receives only that new event.
- Verification: No-op-bridge runtime probes produced `["login_expired"]` for Claude and `["mcp_server_not_logged_in:linear"]` for Codex after attaching late, confirming the implementation. The checked-in socket-backed suites could not run in this sandbox because Unix-socket `listen` fails with `EPERM`.
- Rationale: The current implementation satisfies no-late-replay for both adapters, but the Claude repository regression test can pass if warning delivery is entirely broken because it lacks the requested positive-control warning after subscription.

### partially addressed: Failed starts leak the freshly allocated socket home

- Original: blocker at `src/state/runtime-paths.ts:38`, `src/claude/session.ts:68-119`, and `src/codex/session.ts:66-103`.
- Evidence: `withSocketHomeCleanup` now removes the socket home for any rejected build at `src/runtime/startup-cleanup.ts:25-46`, and both entry points wrap their build at `src/claude/session.ts:43-55` and `src/codex/session.ts:47-59`. Direct PTY-start probes for both adapters returned `pty_start_failed` with no remaining socket homes. However, a bridge whose own `start()` rejects is still only wrapped and rethrown at `src/claude/session-build.ts:79-86` and `src/codex/session-build.ts:66-73`; neither path invokes `bridge.stop()`. Direct probes observed `stops:0` for both adapters. The bridge-failure tests at `tests/claude/session-socket-leak.test.ts:49-60` and `tests/codex/session-socket-leak.test.ts:43-54` do not assert `stop()` was called.
- Verification: Direct no-op-bridge PTY-failure probes confirmed socket-home removal for both adapters. Direct rejecting-bridge probes reproduced the remaining cleanup failure (`{"code":"hook_bridge_failed","stops":0}` for each adapter).
- Rationale: The socket-directory leak itself is fixed across the wrapped build, but the original finding also identified best-effort shutdown of a partially started bridge. That owned-resource cleanup and its regression assertion remain missing.

### addressed: A throwing warning listener can wedge every rendered frame

- Original: blocker at `src/core/session-warnings.ts:26-32`, `src/claude/session.ts:135-153`, and `src/codex/session.ts:132-150`.
- Evidence: `deliverFrameWarnings` contains warning/activity listener failures at `src/core/startup-frame.ts:19-35`. Claude continues from warning delivery through readiness/login observation and `terminal:data` at `src/claude/session-build.ts:106-125`; Codex does the same at `src/codex/session-build.ts:99-118`. The shared emitter still attempts both warning and activity deliveries at `src/core/session-warnings.ts:22-43`.
- Verification: `tests/unit/session-warnings.test.ts` passed in the focused run. No-op-bridge adapter probes with throwing warning listeners reported `ready:"ready"` and `data:1` for both Claude and Codex.
- Rationale: Warning delivery is now behind a narrow containment boundary and cannot abort the rest of a frame; focused unit coverage and adapter-level runtime probes exercise both fan-out and progress.

### addressed: Codex re-emits old startup warnings on unrelated frames

- Original: major at `src/codex/startup-prompts.ts:39`, `src/codex/startup-prompts.ts:63`, `src/codex/startup-prompts.ts:75-82`, `src/codex/session.ts:143`, and `tests/codex/session-start.test.ts:84-91`.
- Evidence: Startup warnings are parsed from the current frame and edge-keyed by semantic banner identity at `src/codex/startup-prompts.ts:72-98`; accumulated text is no longer used for warning extraction. Exact adapter cardinality is asserted at `tests/codex/session-start.test.ts:71-100`, and clear/reappear behavior is covered at `tests/unit/codex-startup-warning-edge.test.ts:12-54`.
- Verification: `tests/unit/codex-startup-warning-edge.test.ts` passed in the focused 53-test run; a no-op-bridge frame probe observed one MCP warning while a throwing listener did not stop frame delivery.
- Rationale: The retained-buffer replay mechanism was removed from warning detection, persistent banners are edge-suppressed, and a banner that clears and reappears is treated as a new occurrence with exact-count coverage.

### addressed: Preflight warnings can be consumed before callers can subscribe

- Original: major at `src/claude/session.ts:129-137`, `src/claude/session.ts:170-190`, `src/codex/session.ts:123-134`, and `src/codex/session.ts:169-195`.
- Evidence: `schedulePreflightWarning` uses a next-macrotask timer at `src/core/startup-frame.ts:37-54`. Both builders schedule only after the startup region succeeds and immediately before returning at `src/claude/session-build.ts:162-166` and `src/codex/session-build.ts:163-166`. The contract is explicit at `PRD.md:2305`, with adapter tests at `tests/claude/session-warning-contract.test.ts:58-69` and `tests/codex/session-warning-contract.test.ts:47-62`.
- Verification: No-op-bridge runtime probes attached synchronously after each start resolved and observed `version_unparseable` for both adapters.
- Rationale: The caller now receives the session before the one-shot preflight warning is delivered, preserving observability without introducing general late replay.

### partially addressed: Per-record warning fan-out defeats the transcript reader's work budget

- Original: major at `src/core/transcript/drops.ts:44-51`, `src/claude/transcript/emit.ts:38-50`, `src/codex/transcript/emit.ts:26-41`, `src/claude/transcript/index.ts:25-26`, and `src/codex/transcript/watcher.ts:23-24`.
- Evidence: `DropReporter` coalesces to one `(path, cause)` warning per scan pass at `src/core/transcript/drops.ts:38-76`; Claude flushes once per bounded scan at `src/claude/transcript/index.ts:75-83`, and Codex does so at `src/codex/transcript/watcher.ts:75-87`. Focused tests assert that 1,000 malformed records produce one warning at `tests/unit/transcript-drops.test.ts:37-47`. However, the specification still says each observation emits a warning at `PRD.md:1513-1515`, and the changelog says each lost record is one warning at `CHANGELOG.md:21-23`.
- Verification: `tests/unit/transcript-drops.test.ts` and `tests/unit/codex-transcript-drops.test.ts` passed in the focused 53-test run.
- Rationale: The synchronous fan-out is now bounded in the implementation, so the performance failure mode is fixed. The chosen coalescing behavior is externally observable and was not reconciled with the PRD/changelog as the original finding required, leaving implementation and specification out of agreement.

### addressed: The adapters duplicate a subtle live-warning router

- Original: major at `src/claude/session-transcript.ts:60-81` and `src/codex/session-transcript.ts:47-68`.
- Evidence: The shared router, including pre-sink buffering, clear-before-delivery, and throw containment, now lives at `src/core/transcript/warning-router.ts:19-52`. Claude delegates to it at `src/claude/session-transcript.ts:61-72`; Codex delegates at `src/codex/session-transcript.ts:43-62`.
- Verification: `tests/unit/claude-transcript-wiring.test.ts` and `tests/unit/codex-session-transcript.test.ts` passed in the focused 53-test run, including pre-sink buffering and throw/drop semantics.
- Rationale: The duplicated contract logic has been extracted into one shared implementation while preserving adapter-specific warning construction and activity mapping.

### addressed: Socket-home ownership depends on a duplicated magic prefix

- Original: minor at `src/state/runtime-paths.ts:38` and `src/state/socket-home.ts:9-16`.
- Evidence: `SOCKET_HOME_PREFIX` is defined once at `src/state/socket-home.ts:9-18`; runtime creation imports and uses it at `src/state/runtime-paths.ts:13-14` and `src/state/runtime-paths.ts:40-49`; removal uses the same constant at `src/state/socket-home.ts:16-28`.
- Verification: `tests/unit/state-store.test.ts` passed in the focused run, including owned socket-home removal and preservation of a foreign home at `tests/unit/state-store.test.ts:87-113`; typecheck passed.
- Rationale: Creation and ownership detection now share the same exported constant, eliminating the production drift path identified by the finding.

## Commands

- `git status --short --untracked-files=all`, `git rev-parse HEAD`, and `git branch --show-current`: clean pre-report tree at `6dae82ff987462517cbff3969d27a28370845841` on `simplify/near-stateless`.
- `git diff --stat/name-status df6acf2ec8b95234e8088cfb8e9527f4038746af..HEAD` and targeted `git diff`: inspected the 69-file remediation delta from the frozen review endpoint.
- `git diff --check df6acf2ec8b95234e8088cfb8e9527f4038746af..HEAD`: passed.
- Targeted `rg`, `sed`, and `nl -ba` inspections over `PRD.md`, `README.md`, `CHANGELOG.md`, current source, and tests: traced every original finding and the cited current lines.
- `npm run typecheck`: passed.
- `npm run lint`: passed; 465 files checked.
- `npm run check:lines`: passed; all checked files are at or below 200 lines.
- Focused non-socket Vitest run over nine state, warning, startup-edge, transcript-drop, and transcript-wiring files with coverage disabled: passed, 9 files / 53 tests.
- Broader focused Vitest run over 14 files: 9 files / 57 tests passed; five socket-backed files could not start because this sandbox rejects Unix-socket `listen` with `EPERM`. A direct error probe confirmed `listen EPERM`, so those 17 failures were environmental rather than assertion failures in the remediated logic.
- Direct no-op-bridge adapter probes: both preflight warnings were observable after return; throwing warning listeners still allowed `ready` and one `terminal:data` event; late subscribers received only the subsequent Claude/Codex warning.
- Direct legacy-record canonicalization probe: passed; retired top-level and adapter keys were absent after the next write.
- Direct PTY-start cleanup probes: passed for both adapters with zero socket homes remaining.
- Direct rejecting-bridge cleanup probes: reproduced the residual gap for both adapters; each returned `hook_bridge_failed` with `stops:0`.
- `npm test` was not run because its configured LCOV reporter writes repository coverage artifacts, which would violate the one-file write constraint.

## Residual Risks

- The sandbox blocks real Unix-domain socket listeners, so the socket-backed adapter conformance files and real bridge integration could not be executed here; no-op-bridge probes covered the relevant session logic.
- The configured 100% coverage thresholds were not re-measured because the coverage command writes LCOV output. The focused tests, typecheck, lint, and line-limit checks passed.
