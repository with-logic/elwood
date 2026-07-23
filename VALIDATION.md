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
- Evidence: The current contract consistently defines live-only warnings with no snapshot at `PRD.md:1269-1274`, bounded per-scan warning coalescing at `PRD.md:1509-1516`, the exact minimal record at `PRD.md:1906-1931`, in-memory-only terminal size at `PRD.md:947-954`, and live-only exit status/reap behavior at `PRD.md:2101-2110`; C-API-14 matches at `PRD.md:2307`. Consumer documentation agrees at `README.md:598-622` and `CHANGELOG.md:16-40`. Claude's retained `name` option is explicitly launch-only at `PRD.md:276-278`, while Codex exposes neither `name` nor `metadata` at `src/codex/session-types.ts:32-61`.
- Verification: Traced every originally cited contract area and its replacements with `nl`/`rg`; `npm run typecheck`, `npm run lint`, and `npm run check:lines` passed.
- Rationale: The former persisted warning/status/terminal-size clauses, warning snapshot, durable reap warning, and contradictory README/changelog claims now resolve to one minimal-record/live-only model. The current specification, public options, and consumer documentation no longer impose mutually exclusive requirements.

### partially addressed: Source documentation still describes removed persistence paths

- Original: major at `src/runtime/session-reap.ts:2-6`, `src/core/activity-lifecycle.ts:36-43`, `src/claude/transcript/warnings.ts:1-5`, `src/claude/transcript/warnings.ts:42-46`, `src/codex/transcript/warnings.ts:29-33`, `src/claude/login-expired.ts:15-29`, `src/claude/resize-restore.ts:1-8`, `src/runtime/session-base.ts:161`, `src/runtime/session-base.ts:180-182`, `src/runtime/status-emit.ts:3-7`, and `src/core/status-categories.ts:2-6`.
- Evidence: The originally cited areas now accurately describe live-only warnings and in-memory state, including `src/runtime/session-reap.ts:2-12`, `src/core/activity-lifecycle.ts:36-42`, `src/claude/transcript/warnings.ts:2-7`, `src/codex/transcript/warnings.ts:2-9`, `src/claude/login-expired.ts:22-29`, `src/claude/resize-restore.ts:2-9`, `src/runtime/session-base.ts:161-168`, `src/runtime/status-emit.ts:2-8`, and `src/core/status-categories.ts:2-7`. However, the current parser comments still say a malformed line is returned to let the caller “count the drop” at `src/claude/transcript/emit.ts:58` and `src/codex/transcript/emit.ts:53`, while the caller actually reports/coalesces a count-free live incident through `DropReporter` at `src/core/transcript/drops.ts:38-77`.
- Verification: A targeted full-source `rg` sweep for persistence, durable, replay, count, tracker, and accounting terminology found the two stale positive “count the drop” claims above. Biome checked 465 files successfully, but lint cannot validate comment semantics.
- Rationale: The main documentation sweep and the previously stale watcher/reporter/fs-guard wording were corrected, but the original finding requested removal of obsolete count semantics throughout source documentation. Two current source comments still describe the removed count model, so the entire issue is not remediated.

### addressed: Live-only emitters retain persistence-oriented names

- Original: minor at `src/runtime/session-base.ts:168`, `src/codex/session-instance.ts:179-180`, `src/core/transcript/drops.ts:31-32`, and `src/core/transcript/drops.ts:55-56`.
- Evidence: The session abstraction now uses `emitWarnings` at `src/runtime/session-base.ts:161-168`, Codex uses `emitCodexWarnings` at `src/codex/session-warnings.ts:11-20`, and transcript diagnostics use `DropReporter` and `ReadErrorReporter` at `src/core/transcript/drops.ts:38-99`.
- Verification: `rg` found no current `recordWarnings`, `recordCodexWarnings`, `DropTracker`, or `ReadErrorTracker` symbol. The focused non-socket suite passed 57/57 tests, including both adapters' reporter/router coverage.
- Rationale: The runtime identifiers now describe emission/reporting rather than durable mutation or accumulated state. The remaining stale prose is accounted for separately in the source-documentation finding.

### addressed: Cleanup helpers take ambiguous adjacent string arguments

- Original: minor at `src/state/runtime-paths.ts:32-36` and `src/state/store.ts:105`.
- Evidence: `sessionRuntime` takes the readonly named `SessionRuntimeInput` at `src/state/runtime-paths.ts:27-43`; `removeSessionFiles` takes `RemoveSessionFilesInput` at `src/state/store.ts:104-116`. Production callers pass named fields at `src/claude/session.ts:47-54`, `src/codex/session.ts:51-58`, and `src/runtime/session-shutdown.ts:150-155`.
- Verification: `npm run typecheck` passed, and the focused state suites passed within the 10-file/57-test non-socket run.
- Rationale: Both helpers and their callers use named, consistently labeled inputs, eliminating the silent positional path/id swap failure mode.

### addressed: Legacy schema-v1 fields cross the validation boundary and are persisted again

- Original: blocker at `src/state/store.ts:23-30`, `src/state/store.ts:72-80`, `src/state/store.ts:96-101`, and `src/state/validate.ts:12-20`.
- Evidence: `validateSessionRecord` constructs a fresh allowlisted top-level record at `src/state/validate.ts:13-30`; `adapterState` reconstructs only validated `resumeId` and launch posture at `src/state/validate.ts:32-45`; `writeSessionRecord` serializes that canonical type at `src/state/store.ts:71-74`. The regression seeds retired paths, warnings, metadata, terminal size, status, timestamps, a bridge credential, and an adapter extra, then asserts exact canonical keys at `tests/unit/state-validate.test.ts:29-60`; minimal persisted JSON is asserted at `tests/unit/state-store.test.ts:56-84`.
- Verification: `tests/unit/state-validate.test.ts`, `tests/unit/state-store.test.ts`, and `tests/unit/state-store-edges.test.ts` passed in the 10-file/57-test focused run.
- Rationale: Legacy schema-v1 input is deliberately migrated by reconstruction rather than returned through a cast. Removed top-level and adapter fields cannot cross validation or be spread back into a later write, matching PRD §8.2.

### addressed: No adapter-level test protects the no-late-replay warning contract

- Original: minor at `tests/unit/session-warnings.test.ts:35-45`.
- Evidence: Session subscription replay is restricted to `terminal:data` at `src/runtime/session-base.ts:169-170`. Claude's adapter regression attaches late, observes no prior preflight warning, then verifies a fresh `login_expired` warning at `tests/claude/session-warning-contract.test.ts:107-127`; Codex performs the equivalent prior-GitHub/subsequent-Linear sequence at `tests/codex/session-warning-contract.test.ts:65-88`.
- Verification: The socket-backed adapter tests were selected, but this sandbox rejected their hook-bridge Unix-socket bind with `EPERM` before the assertions. The checked-in tests directly cover both adapters with positive controls, while the shared reporter/router suites passed in the 10-file/57-test run.
- Rationale: Focused adapter-level coverage now protects the exact late-subscriber failure mode, and current subscription code has no warning replay route. The execution limitation is environmental rather than contrary implementation evidence.

### addressed: Failed starts leak the freshly allocated socket home

- Original: blocker at `src/state/runtime-paths.ts:38`, `src/claude/session.ts:68-119`, and `src/codex/session.ts:66-103`.
- Evidence: `withSocketHomeCleanup` removes the socket home on every rejected build while preserving the original error at `src/runtime/startup-cleanup.ts:25-47`; both adapters wrap the complete build at `src/claude/session.ts:43-55` and `src/codex/session.ts:47-59`. Partial bridge failures stop the bridge at `src/claude/session-build.ts:79-88` and `src/codex/session-build.ts:66-75`; PTY-start failures clean the bridge at `src/claude/session-build.ts:95-101` and `src/codex/session-build.ts:77-83`; all post-spawn steps use the guarded cleanup boundary at `src/runtime/startup-cleanup.ts:76-92`.
- Verification: In the 17-file focused run, both adapter bridge-failure tests, both wrapper file-write-failure tests, and both injected guarded post-spawn failure tests passed; PTY/success cases requiring a real Unix-socket bind were blocked earlier by sandbox `EPERM`. Shared cleanup regressions at `tests/unit/startup-cleanup.test.ts:34-73` passed in the 10-file/57-test run.
- Rationale: Ownership is guarded from the first build write until transfer to the returned session, partially started bridges are stopped, and post-spawn resources share one cleanup boundary. The original leak stages are covered without replacing the startup error.

### addressed: A throwing warning listener can wedge every rendered frame

- Original: blocker at `src/core/session-warnings.ts:26-32`, `src/claude/session.ts:135-153`, and `src/codex/session.ts:132-150`.
- Evidence: `deliverFrameWarnings` contains warning/activity listener failures at `src/core/startup-frame.ts:19-35`. Claude continues after that boundary through readiness/login observation and `terminal:data` at `src/claude/session-build.ts:117-128`; Codex does the same at `src/codex/session-build.ts:110-121`. The shared emitter attempts both projections before rethrowing to the narrow boundary at `src/core/session-warnings.ts:22-43`.
- Verification: Exact adapter regressions exist at `tests/claude/session-warning-contract.test.ts:32-67` and `tests/codex/session-warning-contract.test.ts:21-44`, but sandbox socket binding failed before those assertions. The focused warning/startup unit run passed 15/15 tests, including throwing-listener and readiness-release paths.
- Rationale: Warning telemetry can no longer retain a pending one-shot warning or abort the rest of a frame. Delivery failures are contained at the frame boundary, while readiness, observers, and terminal delivery continue in the current implementation.

### addressed: Codex re-emits old startup warnings on unrelated frames

- Original: major at `src/codex/startup-prompts.ts:39`, `src/codex/startup-prompts.ts:63`, `src/codex/startup-prompts.ts:75-82`, `src/codex/session.ts:143`, and `tests/codex/session-start.test.ts:84-91`.
- Evidence: Startup warnings are parsed from the current frame and edge-keyed by semantic banner identity at `src/codex/startup-prompts.ts:27-32` and `src/codex/startup-prompts.ts:69-98`; accumulated prompt history is not used for warning extraction. Exact adapter cardinality across an unrelated frame is asserted at `tests/codex/session-start.test.ts:71-100`, while retained, cleared/reappeared, and reflowed banners are covered at `tests/unit/codex-startup-warning-edge.test.ts:12-54`.
- Verification: `tests/unit/codex-startup-warning-edge.test.ts` passed in the 10-file/57-test run. The socket-backed adapter cardinality test was selected but could not get past bridge bind in this sandbox.
- Rationale: A retained or scrolled-off banner is no longer reparsed from historical text, while a banner that clears and genuinely reappears emits again, matching C-API-14's once-per-occurrence rule.

### addressed: Preflight warnings can be consumed before callers can subscribe

- Original: major at `src/claude/session.ts:129-137`, `src/claude/session.ts:170-190`, `src/codex/session.ts:123-134`, and `src/codex/session.ts:169-195`.
- Evidence: `schedulePreflightWarning` defers delivery to a post-return macrotask at `src/core/startup-frame.ts:37-54`; both builders schedule it only after guarded startup succeeds at `src/claude/session-build.ts:165-169` and `src/codex/session-build.ts:166-169`. C-API-14 specifies the same handoff at `PRD.md:2307`. Claude's regression emits PTY output before the start promise resolves at `tests/claude/session-warning-contract.test.ts:83-104`, and same-turn post-return subscription is covered for both adapters at `tests/claude/session-warning-contract.test.ts:70-81` and `tests/codex/session-warning-contract.test.ts:47-62`.
- Verification: The adapter tests were selected but sandbox socket binding failed before the assertions; typecheck passed, and static tracing confirms that both adapters share the deferred helper after their guarded startup region.
- Rationale: Pre-return terminal frames no longer consume the preflight warning. A macrotask scheduled immediately before returning gives the caller's post-`await` continuation time to subscribe without restoring general replay, in agreement with the PRD.

### addressed: Per-record warning fan-out defeats the transcript reader's work budget

- Original: major at `src/core/transcript/drops.ts:44-51`, `src/claude/transcript/emit.ts:38-50`, `src/codex/transcript/emit.ts:26-41`, `src/claude/transcript/index.ts:25-26`, and `src/codex/transcript/watcher.ts:23-24`.
- Evidence: PRD §5.4 explicitly coalesces pathological drops per `(path, cause)` per scan at `PRD.md:1509-1516`. `DropReporter` accumulates one notice per key and clears before bounded delivery at `src/core/transcript/drops.ts:38-77`; Claude flushes once per observation/scan/poll at `src/claude/transcript/index.ts:64-82` and `src/claude/transcript/index.ts:99-116`; Codex flushes once per scan at `src/codex/transcript/watcher.ts:75-87`.
- Verification: Focused regressions exercise 1,000 malformed reports collapsing to one notice, distinct keys, later-pass recurrence, and throwing sinks at `tests/unit/transcript-drops.test.ts:37-105`, with Codex aliases covered at `tests/unit/codex-transcript-drops.test.ts:24-61`; both suites passed in the 10-file/57-test run.
- Rationale: The implementation uses the review's permitted coalescing remedy and updates the specification accordingly. Pathological input no longer produces one synchronous warning/activity fan-out per malformed record, while a recurring later-pass incident remains observable.

### addressed: The adapters duplicate a subtle live-warning router

- Original: major at `src/claude/session-transcript.ts:60-81` and `src/codex/session-transcript.ts:47-68`.
- Evidence: Clear-before-delivery buffering, lazy sink resolution, and listener containment now live in `createTranscriptWarningRouter` at `src/core/transcript/warning-router.ts:27-52`. Claude delegates at `src/claude/session-transcript.ts:53-73`, and Codex delegates at `src/codex/session-transcript.ts:43-62`.
- Verification: Claude and Codex warning-router wiring/lifecycle suites passed in the 10-file/57-test run, covering lone pre-sink warnings, clear-before-throw behavior, active throwing sinks, and later independent delivery.
- Rationale: The nontrivial live-warning routing semantics have one shared implementation; adapters now supply only their warning builders, sink lookup, and activity projection.

### addressed: Socket-home ownership depends on a duplicated magic prefix

- Original: minor at `src/state/runtime-paths.ts:38` and `src/state/socket-home.ts:9-16`.
- Evidence: `SOCKET_HOME_PREFIX` is defined once at `src/state/socket-home.ts:9-18`, imported by creation at `src/state/runtime-paths.ts:13-14`, and passed to `mkdtempSync` at `src/state/runtime-paths.ts:40-48`; removal uses the same constant through `ownsSocketHome` at `src/state/socket-home.ts:16-28`.
- Verification: `rg` confirmed production creation and ownership checks share the export; focused state cleanup tests at `tests/unit/state-store.test.ts:87-112` passed.
- Rationale: Production creation and deletion can no longer drift through separately spelled prefixes, so ownership detection will continue to recognize the socket homes that creation mints.

## Commands

- `git status --short --branch --untracked-files=all` — before writing this report, the only worktree change was the pre-existing deletion of `VALIDATION.md`; no staged or untracked changes were present. Focused tests created no repository changes.
- `git rev-parse HEAD`, `git log --oneline --decorate --max-count=12`, `git diff --name-status df6acf2ec8b95234e8088cfb8e9527f4038746af..HEAD`, and `git diff --stat` — inspected current `HEAD` (`8e29614c8ae1d676472227de90a001d704b7c539`), the review endpoint, remediation history, and current staged/unstaged/untracked state.
- `git diff --check df6acf2ec8b95234e8088cfb8e9527f4038746af..HEAD` — passed.
- `rg -n '^#### ' REVIEW.md` — parsed 13 original finding headings.
- Read-only `sed`, `nl`, and `rg` traces over `REVIEW.md`, the frozen endpoint/current diff, `PRD.md`, `README.md`, `CHANGELOG.md`, current source, and focused tests — completed; the source-comment sweep found the two remaining stale “count the drop” comments cited above.
- `npm run typecheck` — passed.
- `npm run lint` — passed; Biome checked 465 files with no fixes.
- `npm run check:lines` — passed; all checked files are at or below 200 lines.
- `./node_modules/.bin/vitest run <17 focused files> --no-cache --no-file-parallelism` — 10 files passed and 7 failed; 67 tests passed and 27 failed. Every failure occurred at real hook-bridge startup with Unix-socket `listen EPERM` before the targeted adapter assertion.
- `./node_modules/.bin/vitest run <10 non-socket focused files> --no-cache --no-file-parallelism` — passed: 10 files, 57 tests.
- `./node_modules/.bin/vitest run tests/unit/session-warnings.test.ts tests/unit/startup-write.test.ts tests/unit/initial-ready-advance.test.ts --no-cache --no-file-parallelism` — passed: 3 files, 15 tests.

## Residual Risks

- This sandbox does not permit the real Unix-socket bind used by the Claude/Codex hook bridge, so 27 socket-backed adapter tests could not reach their target assertions. Their current code and checked-in assertions were traced, and shared/injected-bridge paths passed, but a permissive environment should rerun the full focused adapter set.
