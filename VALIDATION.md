# Review Validation

Verdict: fail

## Summary

- Total findings: 13
- Addressed: 12
- Partially addressed: 1
- Not addressed: 0
- Cannot verify: 0

## Findings

### addressed: The repository now has mutually exclusive conformance requirements

- Original: blocker at `PRD.md:277-279`, `PRD.md:358-359`, `PRD.md:946-954`, `PRD.md:1271-1273`, `PRD.md:1302-1303`, `PRD.md:1504-1511`, `PRD.md:2062-2066`, `PRD.md:2092-2100`, `PRD.md:2309`, `README.md:613-614`, and contradictory entries in `CHANGELOG.md`.
- Evidence: The public Claude interface no longer has a warning snapshot at `PRD.md:396-415`, and the README interface likewise omits it at `README.md:230-257`. Live-only warnings are defined consistently at `PRD.md:1269-1274`, `PRD.md:1553-1561`, and `PRD.md:2307`; the exact minimal record is defined at `PRD.md:1906-1931`; terminal size is explicitly in-memory-only at `PRD.md:947-954`; and startup/exit semantics now match that model at `PRD.md:2049-2064` and `PRD.md:2101-2110`. The README and changelog agree at `README.md:598-622` and `CHANGELOG.md:16-40`. Claude's retained `name` option has a defined non-persistent launch-time effect at `PRD.md:276-278`, while the current Codex options contain no dead `name` or `metadata` field at `src/codex/session-types.ts:32-61`.
- Verification: Traced the cited and replacement PRD, README, changelog, public-type, and source locations with `rg`/`nl`; `npm run typecheck`, `npm run lint`, and `npm run check:lines` all passed.
- Rationale: The stale warning snapshot, durable status/warning fields, terminal-size persistence, and contradictory changelog language have been removed or rewritten. The current consumer documentation and implementation now select one coherent minimal-record/live-only-warning contract.

### partially addressed: Source documentation still describes removed persistence paths

- Original: major at `src/runtime/session-reap.ts:2-6`, `src/core/activity-lifecycle.ts:36-43`, `src/claude/transcript/warnings.ts:1-5`, `src/claude/transcript/warnings.ts:42-46`, `src/codex/transcript/warnings.ts:29-33`, `src/claude/login-expired.ts:15-29`, `src/claude/resize-restore.ts:1-8`, `src/runtime/session-base.ts:161`, `src/runtime/session-base.ts:180-182`, `src/runtime/status-emit.ts:3-7`, and `src/core/status-categories.ts:2-6`.
- Evidence: The originally cited areas now describe live warnings and in-memory status accurately, including `src/runtime/session-reap.ts:2-12`, `src/core/activity-lifecycle.ts:36-43`, `src/claude/transcript/warnings.ts:1-8`, `src/codex/transcript/warnings.ts:1-9`, `src/claude/resize-restore.ts:1-9`, `src/runtime/session-base.ts:157-182`, `src/runtime/status-emit.ts:1-8`, and `src/core/status-categories.ts:1-7`. However, the current Codex watcher still says a scan can throw from “a warning-state write” at `src/codex/transcript/watcher.ts:60-62`, even though warning persistence/state writes were removed and the warning router only performs live delivery at `src/core/transcript/warning-router.ts:31-49`.
- Verification: Repository-wide targeted `rg` searches for durable/persisted warning, warning-state write, status persistence, replay, count, and old emitter/tracker terminology found the remaining source comment above; lint passed over 465 files.
- Rationale: The cited comments were repaired, but the same obsolete persistence model is still documented on a current source path. The requested source-documentation sweep therefore does not fix the entire original issue.

### addressed: Live-only emitters retain persistence-oriented names

- Original: minor at `src/runtime/session-base.ts:168`, `src/codex/session-instance.ts:179-180`, `src/core/transcript/drops.ts:31-32`, and `src/core/transcript/drops.ts:55-56`.
- Evidence: The session abstraction now uses `emitWarnings` at `src/runtime/session-base.ts:161-168`; Codex uses `emitCodexWarnings` at `src/codex/session-warnings.ts:11-20`; and transcript diagnostics are `DropReporter` and `ReadErrorReporter` at `src/core/transcript/drops.ts:38-81`.
- Verification: Targeted symbol search found no current `recordWarnings`, `recordCodexWarnings`, `DropTracker`, or `ReadErrorTracker`. The focused reporter suites passed in the 11-file / 61-test Vitest run.
- Rationale: Persistence-oriented names were replaced consistently with names that describe live emission and reporting.

### addressed: Cleanup helpers take ambiguous adjacent string arguments

- Original: minor at `src/state/runtime-paths.ts:32-36` and `src/state/store.ts:105`.
- Evidence: `sessionRuntime` accepts the readonly named `SessionRuntimeInput` at `src/state/runtime-paths.ts:27-42`; `removeSessionFiles` accepts `RemoveSessionFilesInput` at `src/state/store.ts:104-116`; and production callers use named fields at `src/claude/session.ts:47-54`, `src/codex/session.ts:51-58`, and `src/runtime/session-shutdown.ts:150-155`.
- Verification: Typecheck passed, and `tests/unit/state-store.test.ts` plus `tests/unit/state-store-edges.test.ts` passed in the focused run.
- Rationale: The adjacent positional path/id strings are gone from both helper APIs and their current callers, preventing silent argument swaps.

### addressed: Legacy schema-v1 fields cross the validation boundary and are persisted again

- Original: blocker at `src/state/store.ts:23-30`, `src/state/store.ts:72-80`, `src/state/store.ts:96-101`, and `src/state/validate.ts:12-20`.
- Evidence: `validateSessionRecord` constructs a fresh allowlisted top-level record at `src/state/validate.ts:13-30`, and `adapterState` constructs fresh resume/launch state at `src/state/validate.ts:32-45`; `writeSessionRecord` serializes that canonical type at `src/state/store.ts:71-74`. The regression seeds retired top-level fields, a stale bridge credential, and adapter extras, then asserts the exact canonical keys at `tests/unit/state-validate.test.ts:29-60`.
- Verification: The focused state tests passed. A direct read/update/write probe seeded `bridgeToken`, paths, warnings, metadata, terminal size, status, and adapter `name`; the next persisted JSON contained only `adapter`, `claude`, `codex`, `cwd`, `elwoodSessionId`, and `schemaVersion`, with only `launch`/`resumeId` in Claude state and no stale secret.
- Rationale: Legacy v1 input is deliberately migrated by reconstruction. Removed fields no longer cross the validation boundary or round-trip through resume-id/posture updates.

### addressed: No adapter-level test protects the no-late-replay warning contract

- Original: minor at `tests/unit/session-warnings.test.ts:35-45`.
- Evidence: Session subscription replay is limited to `terminal:data` at `src/runtime/session-base.ts:169-171`. Claude asserts that a late subscriber gets no prior warning and then receives a fresh `login_expired` warning at `tests/claude/session-warning-contract.test.ts:107-127`; Codex asserts no prior GitHub warning and only the subsequent Linear warning at `tests/codex/session-warning-contract.test.ts:65-88`.
- Verification: The checked-in adapter assertions directly exercise the requested late-subscriber sequence and include positive controls. Their socket-backed run was blocked by this sandbox's Unix-socket `EPERM`, but current code tracing, the passing warning-router unit suites, and the no-op-bridge adapter probes confirmed live delivery remains functional.
- Rationale: Both adapters now protect the exact no-late-replay contract, and the positive controls prove an empty late-subscriber result is not caused by broken warning delivery.

### addressed: Failed starts leak the freshly allocated socket home

- Original: blocker at `src/state/runtime-paths.ts:38`, `src/claude/session.ts:68-119`, and `src/codex/session.ts:66-103`.
- Evidence: `withSocketHomeCleanup` removes the socket home on every rejected build at `src/runtime/startup-cleanup.ts:25-47`; both adapters wrap the complete build at `src/claude/session.ts:43-55` and `src/codex/session.ts:47-59`. Partial bridge-start failures best-effort stop the bridge at `src/claude/session-build.ts:79-88` and `src/codex/session-build.ts:66-75`; PTY-start failures clean the bridge at `src/claude/session-build.ts:95-101` and `src/codex/session-build.ts:77-83`; post-spawn failures use the guarded cleanup region at `src/runtime/startup-cleanup.ts:53-92`.
- Verification: Focused bridge-start tests passed for both adapters (2 files / 2 tests, 6 skipped), including rejecting `stop()` paths at `tests/claude/session-socket-leak.test.ts:49-67` and `tests/codex/session-socket-leak.test.ts:43-61`. `tests/unit/startup-cleanup.test.ts:34-57` passed and covers post-spawn cleanup. Direct no-op-bridge PTY-failure probes returned `pty_start_failed` with zero remaining socket homes for both adapters.
- Rationale: Socket-home ownership is guarded around the entire build, all identified failure stages reject through that boundary, and partially started live resources are cleaned without replacing the original error.

### addressed: A throwing warning listener can wedge every rendered frame

- Original: blocker at `src/core/session-warnings.ts:26-32`, `src/claude/session.ts:135-153`, and `src/codex/session.ts:132-150`.
- Evidence: `deliverFrameWarnings` contains warning/activity listener failures at `src/core/startup-frame.ts:19-35`. Claude continues from contained delivery through readiness/login observation and `terminal:data` at `src/claude/session-build.ts:117-128`; Codex does the same at `src/codex/session-build.ts:110-121`. The shared emitter also attempts both warning and activity fan-outs before rethrowing to that boundary at `src/core/session-warnings.ts:22-43`.
- Verification: Focused warning-router tests passed. No-op-bridge adapter probes installed persistently throwing warning listeners; both adapters still reached `ready`, delivered `terminal:data`, and observed their expected live warnings. The checked-in regression intent is explicit at `tests/claude/session-warning-contract.test.ts:32-67` and `tests/codex/session-warning-contract.test.ts:21-44`.
- Rationale: Warning telemetry exceptions are isolated from frame control, so they cannot retain a pending frame warning or skip readiness, observers, and terminal delivery.

### addressed: Codex re-emits old startup warnings on unrelated frames

- Original: major at `src/codex/startup-prompts.ts:39`, `src/codex/startup-prompts.ts:63`, `src/codex/startup-prompts.ts:75-82`, `src/codex/session.ts:143`, and `tests/codex/session-start.test.ts:84-91`.
- Evidence: Startup warnings are parsed from the current frame and edge-keyed by semantic banner identity at `src/codex/startup-prompts.ts:72-98`; accumulated prompt history is no longer used for warning extraction. Exact adapter cardinality across an unrelated frame is asserted at `tests/codex/session-start.test.ts:71-100`, while retained, cleared/reappeared, and reflowed banners are covered at `tests/unit/codex-startup-warning-edge.test.ts:12-54`.
- Verification: `tests/unit/codex-startup-warning-edge.test.ts` passed in the focused run. The socket-backed adapter test was selected but could not start because Unix-socket `listen` is denied by the sandbox.
- Rationale: A retained or scrolled-off occurrence is no longer reparsed from historical text, while a banner that clears and genuinely reappears emits again as C-API-14 requires.

### addressed: Preflight warnings can be consumed before callers can subscribe

- Original: major at `src/claude/session.ts:129-137`, `src/claude/session.ts:170-190`, `src/codex/session.ts:123-134`, and `src/codex/session.ts:169-195`.
- Evidence: `schedulePreflightWarning` defers delivery to a post-return macrotask at `src/core/startup-frame.ts:37-54`; both builders schedule it only after the guarded startup region succeeds at `src/claude/session-build.ts:165-169` and `src/codex/session-build.ts:166-169`. C-API-14 defines the same observable handoff at `PRD.md:2307`.
- Verification: The Claude regression emits PTY output before the start promise resolves and then observes the warning after subscribing at `tests/claude/session-warning-contract.test.ts:83-104`; both adapter suites also assert synchronous post-return subscription at `tests/claude/session-warning-contract.test.ts:70-81` and `tests/codex/session-warning-contract.test.ts:47-62`. Socket-backed execution was blocked by sandbox `EPERM`; no-op-bridge probes observed `version_unparseable` after post-return subscription for both adapters while warning listeners threw.
- Rationale: Startup-frame output can no longer consume the preflight warning before a caller owns the session, and the deferred handoff agrees with the specification without adding general warning replay.

### addressed: Per-record warning fan-out defeats the transcript reader's work budget

- Original: major at `src/core/transcript/drops.ts:44-51`, `src/claude/transcript/emit.ts:38-50`, `src/codex/transcript/emit.ts:26-41`, `src/claude/transcript/index.ts:25-26`, and `src/codex/transcript/watcher.ts:23-24`.
- Evidence: `DropReporter` coalesces to one warning per `(path, cause)` per scan pass at `src/core/transcript/drops.ts:38-76`; Claude flushes once per scan at `src/claude/transcript/index.ts:75-83`, and Codex does so at `src/codex/transcript/watcher.ts:75-88`. The revised contract explicitly permits this bound at `PRD.md:1505-1516` and `CHANGELOG.md:21-25`.
- Verification: The focused regression proves 1,000 malformed records produce one delivery at `tests/unit/transcript-drops.test.ts:37-45`; matching Codex cause coalescing is asserted at `tests/unit/codex-transcript-drops.test.ts:24-37`. Both suites passed.
- Rationale: Synchronous listener fan-out is now bounded independently of record count, later passes can report fresh incidents, and implementation, tests, PRD, and changelog agree on per-pass coalescing.

### addressed: The adapters duplicate a subtle live-warning router

- Original: major at `src/claude/session-transcript.ts:60-81` and `src/codex/session-transcript.ts:47-68`.
- Evidence: Pre-sink buffering, clear-before-delivery, and throw containment are centralized at `src/core/transcript/warning-router.ts:19-51`. Claude delegates to it at `src/claude/session-transcript.ts:53-74`, and Codex delegates at `src/codex/session-transcript.ts:43-63`.
- Verification: `tests/unit/claude-transcript-wiring.test.ts` and `tests/unit/codex-session-transcript.test.ts` passed in the focused run, including lone pre-sink buffering, clear-before-delivery, and throwing-sink behavior.
- Rationale: The contract-sensitive router logic now has one shared implementation; adapters supply only warning construction and event projection.

### addressed: Socket-home ownership depends on a duplicated magic prefix

- Original: minor at `src/state/runtime-paths.ts:38` and `src/state/socket-home.ts:9-16`.
- Evidence: `SOCKET_HOME_PREFIX` is defined once and used by the ownership predicate at `src/state/socket-home.ts:9-28`; runtime creation imports and uses the same constant at `src/state/runtime-paths.ts:13-14` and `src/state/runtime-paths.ts:40-49`.
- Verification: `tests/unit/state-store.test.ts` passed, including owned-home removal and foreign-home preservation at `tests/unit/state-store.test.ts:87-113`; typecheck passed.
- Rationale: Creation and cleanup now share one prefix and ownership predicate, eliminating the identified drift path.

## Commands

- `git status --short --branch --untracked-files=all`, `git log -8 --oneline --decorate`, and frozen-endpoint inspections of `df6acf2ec8b95234e8088cfb8e9527f4038746af..HEAD`: HEAD is `4bf28c7`; before this report was written, the only worktree change was the requested missing `VALIDATION.md`, with no staged or untracked repository changes.
- `git diff --check` and `git diff --check df6acf2ec8b95234e8088cfb8e9527f4038746af..HEAD`: passed.
- Targeted `rg`, `nl`, `sed`, `git show`, and `git diff` inspections over `REVIEW.md`, the remediation range, `PRD.md`, `README.md`, `CHANGELOG.md`, current source, and tests: traced all 13 findings.
- `npm run typecheck`: passed.
- `npm run lint`: passed; 465 files checked with no fixes.
- `npm run check:lines`: passed; all checked files are at or below 200 lines.
- Focused Vitest run with coverage and cache disabled over 11 state, startup-cleanup, warning-router, startup-edge, and transcript-drop files: passed, 11 files / 61 tests.
- Focused bridge-start failure run over both adapter socket-leak files: passed, 2 files / 2 tests (6 skipped by the name filter).
- Focused socket-backed warning/startup run over three adapter files: 8 selected tests could not start because the sandbox rejects Unix-socket hook-bridge listeners with `EPERM`; 6 tests were skipped by the name filter.
- Direct no-op-bridge adapter probes: throwing warning listeners still reached `ready` and delivered terminal data, and post-return subscribers observed preflight warnings for both adapters.
- Direct no-op-bridge PTY-start cleanup probes: passed for both adapters with `pty_start_failed` and zero remaining socket homes.
- Direct legacy-record read/update/write probe: passed; the next persisted record contained only the six approved top-level keys and allowlisted adapter state, with no retired credential.
- `npm test` was not run because the configured LCOV reporter writes repository coverage artifacts, which would violate the one-file write constraint.

## Residual Risks

- The stale source comment at `src/codex/transcript/watcher.ts:60-62` is the reason the source-documentation finding remains partially addressed.
- Related stale test descriptions remain at `tests/claude/session-transcript-drops.test.ts:1-16`, `tests/claude/session-transcript-drops.test.ts:80`, `tests/unit/codex-transcript-watcher.test.ts:1-7`, `tests/unit/transcript-warnings.test.ts:18-21`, and `tests/unit/codex-session-transcript.test.ts:108-120`; their assertions exercise live behavior, but their prose still uses removed persistence terminology.
- Real Unix-socket integration was unavailable in this sandbox, so affected adapter behavior was verified through current code/tests, passing unit suites, and no-op-bridge probes rather than a live hook-bridge listener.
- Full 100% coverage thresholds were not re-measured because the configured coverage run writes LCOV output.
