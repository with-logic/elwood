# Review Validation

Verdict: fail

## Summary

- Total findings: 13
- Addressed: 10
- Partially addressed: 3
- Not addressed: 0
- Cannot verify: 0

## Findings

### partially addressed: The repository now has mutually exclusive conformance requirements

- Original: blocker at `PRD.md:277-279`, `PRD.md:358-359`, `PRD.md:946-954`, `PRD.md:1271-1273`, `PRD.md:1302-1303`, `PRD.md:1504-1511`, `PRD.md:2062-2066`, `PRD.md:2092-2100`, `PRD.md:2309`, `README.md:613-614`, and contradictory entries in `CHANGELOG.md`.
- Evidence: The minimal record and live-only warning model is now explicit at `PRD.md:1270-1275`, `PRD.md:1907-1932`, `README.md:599-623`, and `CHANGELOG.md:16-40`; Claude's retained `name` option is defined as a non-persistent launch flag at `PRD.md:276-278`, while the undefined Codex `name` option is gone at `PRD.md:1153-1168`. However, `PRD.md:399-404` still requires `ClaudeSession.warnings`, and `README.md:234-240` still advertises the same snapshot, directly contradicting `PRD.md:1272-1275` and `README.md:620-622`, which say no such property exists.
- Verification: Traced the current PRD, README, changelog, public types, and implementation with targeted `rg`/`nl`; `npm run typecheck`, `npm run lint`, and `npm run check:lines` passed.
- Rationale: Most stale persistence clauses and changelog conflicts were reconciled, but the public API documentation still specifies the removed warning snapshot in two consumer-visible places. The contract therefore remains internally inconsistent.

### partially addressed: Source documentation still describes removed persistence paths

- Original: major at `src/runtime/session-reap.ts:2-6`, `src/core/activity-lifecycle.ts:36-43`, `src/claude/transcript/warnings.ts:1-5`, `src/claude/transcript/warnings.ts:42-46`, `src/codex/transcript/warnings.ts:29-33`, `src/claude/login-expired.ts:15-29`, `src/claude/resize-restore.ts:1-8`, `src/runtime/session-base.ts:161`, `src/runtime/session-base.ts:180-182`, `src/runtime/status-emit.ts:3-7`, and `src/core/status-categories.ts:2-6`.
- Evidence: The cited areas now describe live-only warnings and in-memory status correctly, including `src/runtime/session-reap.ts:2-12`, `src/core/activity-lifecycle.ts:36-43`, `src/claude/transcript/warnings.ts:1-8`, `src/runtime/status-emit.ts:2-8`, and `src/core/status-categories.ts:1-7`. A stale persistence claim remains at `src/runtime/initial-ready.ts:77-79`, where a callback failure is still described as a possible “failed durable status write,” even though status is never persisted.
- Verification: Repository-wide targeted searches for durable/persisted warning, status, resize, replay, count, and record terminology; Biome checked 465 files with no lint failures.
- Rationale: The original cited comments were repaired, but the same removed durable-status model remains documented elsewhere on the current readiness path. The source documentation sweep is therefore incomplete.

### addressed: Live-only emitters retain persistence-oriented names

- Original: minor at `src/runtime/session-base.ts:168`, `src/codex/session-instance.ts:179-180`, `src/core/transcript/drops.ts:31-32`, and `src/core/transcript/drops.ts:55-56`.
- Evidence: The session abstraction uses `emitWarnings` at `src/runtime/session-base.ts:161-168`; Codex uses `emitCodexWarnings` at `src/codex/session-warnings.ts:11-20`; transcript diagnostics use `DropReporter` and `ReadErrorReporter` at `src/core/transcript/drops.ts:44-80`.
- Verification: Targeted symbol search found no current `recordWarnings`, `recordCodexWarnings`, `DropTracker`, or `ReadErrorTracker`; typecheck and the focused reporter tests passed.
- Rationale: Persistence-oriented names were replaced consistently with names that describe live emission/reporting.

### addressed: Cleanup helpers take ambiguous adjacent string arguments

- Original: minor at `src/state/runtime-paths.ts:32-36` and `src/state/store.ts:105`.
- Evidence: `sessionRuntime` accepts the readonly named `SessionRuntimeInput` at `src/state/runtime-paths.ts:27-42`; `removeSessionFiles` accepts `RemoveSessionFilesInput` at `src/state/store.ts:104-116`; production callers pass named fields at `src/claude/session.ts:47-54`, `src/codex/session.ts:51-58`, and `src/runtime/session-shutdown.ts:151-155`.
- Verification: `tests/unit/state-store.test.ts` and `tests/unit/state-store-edges.test.ts` passed in the focused Vitest run; typecheck passed.
- Rationale: The ambiguous positional path/id strings are gone from both helpers and all current callers.

### addressed: Legacy schema-v1 fields cross the validation boundary and are persisted again

- Original: blocker at `src/state/store.ts:23-30`, `src/state/store.ts:72-80`, `src/state/store.ts:96-101`, and `src/state/validate.ts:12-20`.
- Evidence: `validateSessionRecord` constructs a fresh allowlisted top-level record at `src/state/validate.ts:13-30`, and `adapterState` constructs fresh resume/launch state at `src/state/validate.ts:32-45`; `writeSessionRecord` serializes that canonical record at `src/state/store.ts:71-74`. The legacy-field regression seeds retired top-level and adapter fields and asserts the exact canonical keys at `tests/unit/state-validate.test.ts:29-60`.
- Verification: Focused state tests passed. A direct read-update-write probe seeded `bridgeToken`, paths, warnings, metadata, terminal size, status, and adapter `name`; the persisted result contained only `adapter`, `claude`, `codex`, `cwd`, `elwoodSessionId`, and `schemaVersion`, with only `launch`/`resumeId` in Claude state and no stale secret.
- Rationale: Untrusted legacy objects no longer cross the validation boundary, and the next write cannot round-trip removed fields or the retired IPC credential. The focused test would fail under the original return-and-spread implementation.

### addressed: No adapter-level test protects the no-late-replay warning contract

- Original: minor at `tests/unit/session-warnings.test.ts:35-45`.
- Evidence: Session subscription replay is limited to `terminal:data` at `src/runtime/session-base.ts:169-171`. Claude now asserts no prior warning plus a positive-control new `login_expired` warning at `tests/claude/session-warning-contract.test.ts:84-104`; Codex asserts no prior GitHub warning and only the subsequent Linear warning at `tests/codex/session-warning-contract.test.ts:65-88`.
- Verification: The socket-backed adapter files could not start in this sandbox because Unix-socket `listen` returns `EPERM`. Equivalent no-op-bridge probes passed: a late Claude subscriber saw only `login_expired`, and a late Codex subscriber saw only the newly emitted MCP warning.
- Rationale: Both adapters now have the requested late-subscriber sequence with a positive control proving live delivery remains functional.

### addressed: Failed starts leak the freshly allocated socket home

- Original: blocker at `src/state/runtime-paths.ts:38`, `src/claude/session.ts:68-119`, and `src/codex/session.ts:66-103`.
- Evidence: `withSocketHomeCleanup` removes the socket home on every rejected build at `src/runtime/startup-cleanup.ts:25-47`, and both adapters wrap the complete build at `src/claude/session.ts:43-55` and `src/codex/session.ts:47-59`. Bridge-start catches now best-effort `stop()` the partial bridge while preserving the original error at `src/claude/session-build.ts:79-88` and `src/codex/session-build.ts:66-75`; PTY-start failures clean the bridge at `src/claude/session-build.ts:95-101` and `src/codex/session-build.ts:77-83`; guarded post-spawn cleanup is centralized at `src/runtime/startup-cleanup.ts:53-92`.
- Verification: The focused bridge-start tests passed for both adapters (2 files / 2 tests), including a rejecting `stop()` and an exact one-call assertion at `tests/claude/session-socket-leak.test.ts:49-67` and `tests/codex/session-socket-leak.test.ts:43-61`. Direct no-op-bridge PTY-failure probes returned `pty_start_failed` with zero socket homes for both adapters. `tests/unit/startup-cleanup.test.ts` passed as part of the 58-test focused run, covering guarded post-spawn teardown.
- Rationale: Socket-home ownership is protected around the entire build, every identified pre-transfer failure rejects through that boundary, partial bridges are stopped, and focused coverage exercises the cleanup components and both adapter paths.

### addressed: A throwing warning listener can wedge every rendered frame

- Original: blocker at `src/core/session-warnings.ts:26-32`, `src/claude/session.ts:135-153`, and `src/codex/session.ts:132-150`.
- Evidence: `deliverFrameWarnings` contains listener failures at `src/core/startup-frame.ts:19-35`. Claude continues from contained warning delivery through readiness/login observation and `terminal:data` at `src/claude/session-build.ts:117-128`; Codex does the same at `src/codex/session-build.ts:110-121`.
- Verification: Shared warning tests passed. No-op-bridge adapter probes with deliberately throwing warning listeners reached `ready` and delivered two `terminal:data` events for both Claude and Codex.
- Rationale: Telemetry exceptions are now isolated from the frame-control path, so they cannot retain a pending one-shot warning or abort readiness and terminal delivery.

### addressed: Codex re-emits old startup warnings on unrelated frames

- Original: major at `src/codex/startup-prompts.ts:39`, `src/codex/startup-prompts.ts:63`, `src/codex/startup-prompts.ts:75-82`, `src/codex/session.ts:143`, and `tests/codex/session-start.test.ts:84-91`.
- Evidence: Warnings are parsed from the current frame and edge-keyed by semantic banner identity at `src/codex/startup-prompts.ts:72-98`; the accumulated prompt buffer is no longer used for warning extraction. Exact adapter cardinality is asserted at `tests/codex/session-start.test.ts:71-100`, while persistence, clearing, reappearance, and reflow are covered at `tests/unit/codex-startup-warning-edge.test.ts:12-54`.
- Verification: `tests/unit/codex-startup-warning-edge.test.ts` passed in the focused run. The adapter test could not bind its Unix socket in this sandbox, but its current exact assertions were inspected.
- Rationale: A retained or scrolled-off occurrence is no longer reparsed from historical text, while a banner that clears and genuinely reappears emits again as specified.

### partially addressed: Preflight warnings can be consumed before callers can subscribe

- Original: major at `src/claude/session.ts:129-137`, `src/claude/session.ts:170-190`, `src/codex/session.ts:123-134`, and `src/codex/session.ts:169-195`.
- Evidence: `schedulePreflightWarning` defers delivery to a post-return macrotask at `src/core/startup-frame.ts:37-54`; both builders call it only after the guarded startup region succeeds at `src/claude/session-build.ts:165-169` and `src/codex/session-build.ts:166-169`; C-API-14 specifies that handoff at `PRD.md:2308`. The checked-in adapter tests only subscribe after an otherwise quiet fake start at `tests/claude/session-warning-contract.test.ts:70-81` and `tests/codex/session-warning-contract.test.ts:47-62`; neither makes the fake PTY emit ordinary output before the start promise resolves, which was the original race the review required them to protect.
- Verification: A direct no-op-bridge probe scheduled PTY output during startup before each start promise resolved; a listener attached immediately after return still observed `version_unparseable` for both adapters. The checked-in socket-backed tests were blocked by sandbox `EPERM`.
- Rationale: The current implementation fixes the race and agrees with C-API-14, but focused regression coverage for the stated real-CLI failure mode remains incomplete. The present tests do not exercise pre-return terminal output.

### addressed: Per-record warning fan-out defeats the transcript reader's work budget

- Original: major at `src/core/transcript/drops.ts:44-51`, `src/claude/transcript/emit.ts:38-50`, `src/codex/transcript/emit.ts:26-41`, `src/claude/transcript/index.ts:25-26`, and `src/codex/transcript/watcher.ts:23-24`.
- Evidence: `DropReporter` coalesces to one warning per `(path, cause)` per scan pass at `src/core/transcript/drops.ts:38-76`; the contract explicitly defines the bound at `PRD.md:1511-1517` and `CHANGELOG.md:21-25`. The focused regression asserts that 1,000 malformed records produce one delivery at `tests/unit/transcript-drops.test.ts:37-45`, with matching Codex coverage at `tests/unit/codex-transcript-drops.test.ts:24-37`.
- Verification: Both reporter suites passed in the 58-test focused run.
- Rationale: Synchronous listener fan-out is bounded independently of record count, later scan passes can report fresh incidents, and implementation, tests, PRD, and changelog now agree on coalescing.

### addressed: The adapters duplicate a subtle live-warning router

- Original: major at `src/claude/session-transcript.ts:60-81` and `src/codex/session-transcript.ts:47-68`.
- Evidence: The shared buffer/router, including pre-sink buffering, clear-before-delivery, and throw containment, lives at `src/core/transcript/warning-router.ts:19-51`. Claude delegates at `src/claude/session-transcript.ts:53-74`; Codex delegates at `src/codex/session-transcript.ts:43-63`.
- Verification: `tests/unit/claude-transcript-wiring.test.ts` and `tests/unit/codex-session-transcript.test.ts` passed in the focused run, including pre-sink buffering and throw/drop behavior.
- Rationale: The duplicated contract logic is now centralized, with adapters supplying only their warning construction and event projection.

### addressed: Socket-home ownership depends on a duplicated magic prefix

- Original: minor at `src/state/runtime-paths.ts:38` and `src/state/socket-home.ts:9-16`.
- Evidence: `SOCKET_HOME_PREFIX` is defined once and used by the ownership predicate at `src/state/socket-home.ts:9-28`; runtime creation imports and uses the same constant at `src/state/runtime-paths.ts:13-14` and `src/state/runtime-paths.ts:40-49`.
- Verification: `tests/unit/state-store.test.ts` passed, including owned-home removal and preservation of a foreign home at `tests/unit/state-store.test.ts:87-113`; typecheck passed.
- Rationale: Creation and cleanup now share one prefix and ownership predicate, eliminating the drift path identified by the finding.

## Commands

- `git status --short --untracked-files=all`, `git log -8 --oneline --decorate`, and frozen-endpoint diff/stat inspections: HEAD is `c97b328`; before writing this report the only worktree change was the requested missing `VALIDATION.md`, with no staged or untracked repository changes.
- `git diff --check df6acf2ec8b95234e8088cfb8e9527f4038746af..HEAD` and `git diff --check`: passed.
- Targeted `rg`, `nl`, `sed`, and `git diff` inspections over `REVIEW.md`, `PRD.md`, `README.md`, `CHANGELOG.md`, current source, and tests: traced all 13 findings and the two remediation commits after the frozen endpoint.
- `npm run typecheck`: passed.
- `npm run lint`: passed; 465 files checked with no fixes.
- `npm run check:lines`: passed; all checked files are at or below 200 lines.
- Focused Vitest run with cache and coverage disabled over 10 state, startup-cleanup, warning, startup-edge, transcript-drop, and transcript-router files: passed, 10 files / 58 tests.
- Focused bridge-start failure run over both adapter socket-leak files: passed, 2 files / 2 tests (6 skipped by the name filter).
- Broader adapter Vitest run over five warning/socket/start files: 4 tests passed and 17 could not start because the sandbox rejects Unix-socket listeners; a direct `node:net` probe confirmed `listen EPERM`.
- Direct no-op-bridge adapter probes: throwing warning listeners still reached `ready` and delivered terminal data; late subscribers received only subsequent warnings; preflight warnings remained observable after pre-return PTY output.
- Direct legacy-record read/update/write probe: passed; the next persisted record contained only the six approved top-level keys and allowlisted adapter state, with no retired secret.
- Direct no-op-bridge PTY-start cleanup probes: passed for both adapters with `pty_start_failed` and zero remaining socket homes.
- `npm test` was not run because the configured LCOV reporter writes repository coverage artifacts, which would violate the one-file write constraint.

## Residual Risks

- The sandbox blocks real Unix-domain socket listeners, so the socket-backed adapter tests and real bridge integration could not be executed here; no-op-bridge probes covered the affected session logic.
- Full 100% coverage thresholds were not re-measured because the configured coverage run writes LCOV output.
- Additional documentation drift remains outside the original persistence-path locations: `src/core/warnings.ts:95` says “one live warning per drop” despite per-pass coalescing, and `src/claude/session-build.ts:165-167` / `src/codex/session-build.ts:166-167` call the deferred macrotask a microtask.
