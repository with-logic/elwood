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
- Evidence: The current contract defines live-only warnings with no snapshot at `PRD.md:1269-1274`, `PRD.md:1553-1561`, and `PRD.md:2307`; the exact minimal record at `PRD.md:1906-1931`; in-memory-only terminal size at `PRD.md:947-954`; live status and reap behavior at `PRD.md:2049-2064` and `PRD.md:2101-2115`; and the same privacy model at `README.md:598-622` and `CHANGELOG.md:16-40`. Claude's retained `name` option is explicitly launch-only at `PRD.md:276-278`, while the Codex option types have no `name` or `metadata` field at `src/codex/session-types.ts:32-61`.
- Verification: Traced the cited and replacement contract locations with `nl`/`rg`; `npm run typecheck`, `npm run lint`, and `npm run check:lines` passed.
- Rationale: The specification, consumer documentation, public types, and changelog now choose one coherent minimal-record/live-only-warning model. The stale warning snapshot, durable status/warning fields, persisted terminal size, and contradictory changelog claims are gone.

### partially addressed: Source documentation still describes removed persistence paths

- Original: major at `src/runtime/session-reap.ts:2-6`, `src/core/activity-lifecycle.ts:36-43`, `src/claude/transcript/warnings.ts:1-5`, `src/claude/transcript/warnings.ts:42-46`, `src/codex/transcript/warnings.ts:29-33`, `src/claude/login-expired.ts:15-29`, `src/claude/resize-restore.ts:1-8`, `src/runtime/session-base.ts:161`, `src/runtime/session-base.ts:180-182`, `src/runtime/status-emit.ts:3-7`, and `src/core/status-categories.ts:2-6`.
- Evidence: The originally cited areas now accurately describe live warnings and in-memory state, including `src/runtime/session-reap.ts:1-12`, `src/core/activity-lifecycle.ts:36-43`, `src/claude/transcript/warnings.ts:1-8`, `src/codex/transcript/warnings.ts:1-9`, `src/claude/resize-restore.ts:1-9`, `src/runtime/status-emit.ts:1-8`, `src/core/status-categories.ts:1-7`, and `src/codex/transcript/watcher.ts:60-62`. However, current source comments still say Codex drops are “counted” through a “drop tracker” at `src/codex/transcript/emit.ts:1-5`, call the shared reporters “trackers” at `src/claude/transcript/drops.ts:1-5` and `src/codex/transcript/drops.ts:1-5`, and say contained read failures are counted at `src/claude/transcript/fs-guard.ts:13` and `src/codex/transcript/fs-guard.ts:12`. The implementation instead coalesces count-free live notices through `DropReporter`/`ReadErrorReporter` at `src/core/transcript/drops.ts:38-99`.
- Verification: A repository-wide targeted `rg` search for persistence, count, accounting, and tracker terminology found the remaining comments above. Lint passed over 465 files, but lint cannot validate comment semantics.
- Rationale: Most stale comments were corrected, including the previously reported warning-state-write comment, but the requested source-documentation sweep is incomplete. Several current source headers and inline comments still describe the removed count/tracker model, so the entire original documentation issue is not fixed.

### addressed: Live-only emitters retain persistence-oriented names

- Original: minor at `src/runtime/session-base.ts:168`, `src/codex/session-instance.ts:179-180`, `src/core/transcript/drops.ts:31-32`, and `src/core/transcript/drops.ts:55-56`.
- Evidence: The session abstraction uses `emitWarnings` at `src/runtime/session-base.ts:161-168`, Codex uses `emitCodexWarnings` at `src/codex/session-warnings.ts:11-20`, and transcript diagnostics are implemented by `DropReporter` and `ReadErrorReporter` at `src/core/transcript/drops.ts:38-99`.
- Verification: `rg` found no current `recordWarnings`, `recordCodexWarnings`, `DropTracker`, or `ReadErrorTracker` symbol in source or tests. The focused reporter suites passed.
- Rationale: The persistence-oriented runtime identifiers were replaced consistently with emit/report names. The remaining stale prose is accounted for separately under the source-documentation finding.

### addressed: Cleanup helpers take ambiguous adjacent string arguments

- Original: minor at `src/state/runtime-paths.ts:32-36` and `src/state/store.ts:105`.
- Evidence: `sessionRuntime` accepts the readonly named `SessionRuntimeInput` at `src/state/runtime-paths.ts:27-42`; `removeSessionFiles` accepts `RemoveSessionFilesInput` at `src/state/store.ts:104-116`; production callers pass named fields at `src/claude/session.ts:47-54`, `src/codex/session.ts:51-58`, and `src/runtime/session-shutdown.ts:150-155`.
- Verification: `npm run typecheck` passed, and the focused state suites passed 57/57 as part of the non-socket run.
- Rationale: Both helpers and their callers now use named, consistently labeled inputs, eliminating the silent positional-string swap failure mode.

### addressed: Legacy schema-v1 fields cross the validation boundary and are persisted again

- Original: blocker at `src/state/store.ts:23-30`, `src/state/store.ts:72-80`, `src/state/store.ts:96-101`, and `src/state/validate.ts:12-20`.
- Evidence: `validateSessionRecord` constructs a fresh allowlisted top-level record at `src/state/validate.ts:20-30`, and `adapterState` constructs fresh resume/launch state at `src/state/validate.ts:32-45`; `writeSessionRecord` serializes that canonical type at `src/state/store.ts:71-74`. The regression seeds retired paths, warnings, metadata, terminal size, status, timestamps, a stale bridge credential, and an adapter extra, then asserts the exact canonical keys at `tests/unit/state-validate.test.ts:29-60`; the persisted minimal shape is asserted at `tests/unit/state-store.test.ts:56-84`.
- Verification: `tests/unit/state-validate.test.ts`, `tests/unit/state-store.test.ts`, and `tests/unit/state-store-edges.test.ts` passed in the 10-file / 57-test focused run.
- Rationale: Legacy schema-v1 input is deliberately migrated by reconstruction. Removed top-level and adapter keys cannot cross validation or be spread back into a subsequent resume-id/posture write.

### addressed: No adapter-level test protects the no-late-replay warning contract

- Original: minor at `tests/unit/session-warnings.test.ts:35-45`.
- Evidence: Session subscription replay is restricted to `terminal:data` at `src/runtime/session-base.ts:169-171`. Claude's adapter regression attaches late, expects no prior warning, then verifies a fresh `login_expired` warning at `tests/claude/session-warning-contract.test.ts:107-127`; Codex performs the equivalent prior-GitHub/subsequent-Linear sequence at `tests/codex/session-warning-contract.test.ts:65-88`.
- Verification: The adapter tests were selected, but this sandbox rejected their real hook-bridge Unix-socket startup with `hook_bridge_failed` before the assertions. The checked-in tests directly cover both adapters with positive controls, and the shared warning-router unit suites passed in the 10-file / 57-test run.
- Rationale: Focused adapter-level coverage now protects the exact late-subscriber failure mode, and current code has no warning replay route. The inability to execute the socket-backed tests here is an environment limitation, not contrary implementation evidence.

### addressed: Failed starts leak the freshly allocated socket home

- Original: blocker at `src/state/runtime-paths.ts:38`, `src/claude/session.ts:68-119`, and `src/codex/session.ts:66-103`.
- Evidence: `withSocketHomeCleanup` removes the socket home for any rejected build while preserving the original error at `src/runtime/startup-cleanup.ts:25-47`; both adapters wrap their complete builds at `src/claude/session.ts:43-55` and `src/codex/session.ts:47-59`. Partial bridge-start failures stop the bridge at `src/claude/session-build.ts:79-88` and `src/codex/session-build.ts:66-75`; PTY-start failures clean the bridge at `src/claude/session-build.ts:95-101` and `src/codex/session-build.ts:77-83`; post-spawn failures pass through the shared guarded region at `src/runtime/startup-cleanup.ts:76-92`.
- Verification: In the socket-backed run, both adapter bridge-failure tests and both wrapper-level file-write-failure tests passed; PTY/success cases were blocked earlier by the sandbox's bridge bind failure. The shared guarded post-spawn cleanup suite at `tests/unit/startup-cleanup.test.ts:34-73` passed in the 10-file / 57-test run.
- Rationale: Socket-home ownership is guarded around every pre-transfer build path, partially started bridges are stopped, and live post-spawn resources are behind one cleanup boundary. The implementation fixes all originally identified leak stages without replacing the startup error.

### addressed: A throwing warning listener can wedge every rendered frame

- Original: blocker at `src/core/session-warnings.ts:26-32`, `src/claude/session.ts:135-153`, and `src/codex/session.ts:132-150`.
- Evidence: `deliverFrameWarnings` contains warning/activity listener failures at `src/core/startup-frame.ts:19-35`. Claude continues after that boundary through readiness/login observation and `terminal:data` at `src/claude/session-build.ts:117-128`; Codex follows the same ordering at `src/codex/session-build.ts:110-121`. The shared emitter attempts both event projections before rethrowing to the narrow containment boundary at `src/core/session-warnings.ts:22-43`.
- Verification: The exact adapter regressions are present at `tests/claude/session-warning-contract.test.ts:32-67` and `tests/codex/session-warning-contract.test.ts:21-44`, but their run was blocked at Unix-socket bridge startup. Passing transcript-router tests covered persistent throwing listeners and clear-before-delivery containment in the 10-file / 57-test run.
- Rationale: Telemetry failures are now isolated from frame control, so they cannot retain a pending frame warning or skip readiness, observers, and terminal delivery.

### addressed: Codex re-emits old startup warnings on unrelated frames

- Original: major at `src/codex/startup-prompts.ts:39`, `src/codex/startup-prompts.ts:63`, `src/codex/startup-prompts.ts:75-82`, `src/codex/session.ts:143`, and `tests/codex/session-start.test.ts:84-91`.
- Evidence: Startup warnings are parsed from the current frame and edge-keyed by semantic banner identity at `src/codex/startup-prompts.ts:72-98`; accumulated prompt history is not used for warning extraction. Exact adapter cardinality across an unrelated frame is asserted at `tests/codex/session-start.test.ts:71-100`, and retained, cleared/reappeared, and reflowed banners are covered at `tests/unit/codex-startup-warning-edge.test.ts:12-54`.
- Verification: `tests/unit/codex-startup-warning-edge.test.ts` passed in the 10-file / 57-test run. The socket-backed adapter cardinality test was selected but could not pass bridge startup in this sandbox.
- Rationale: A retained or scrolled-off occurrence is no longer reparsed from historical text, while a banner that clears and genuinely reappears emits again as C-API-14 requires.

### addressed: Preflight warnings can be consumed before callers can subscribe

- Original: major at `src/claude/session.ts:129-137`, `src/claude/session.ts:170-190`, `src/codex/session.ts:123-134`, and `src/codex/session.ts:169-195`.
- Evidence: `schedulePreflightWarning` defers delivery to a post-return macrotask at `src/core/startup-frame.ts:37-54`; both builders schedule it only after guarded startup succeeds at `src/claude/session-build.ts:165-169` and `src/codex/session-build.ts:166-169`. The API contract specifies this handoff at `PRD.md:2307`. Claude's regression emits PTY output before the start promise resolves and subscribes only after return at `tests/claude/session-warning-contract.test.ts:83-104`; same-turn subscription is also covered for both adapters at `tests/claude/session-warning-contract.test.ts:70-81` and `tests/codex/session-warning-contract.test.ts:47-62`.
- Verification: The adapter tests were selected but blocked by Unix-socket bridge startup before reaching these assertions; typecheck and static tracing confirmed the deferred scheduling path and its agreement with C-API-14.
- Rationale: Pre-return terminal output can no longer consume the preflight warning. Delivery is scheduled only after the session is ready to return, giving the caller's synchronous post-`await` continuation time to subscribe without adding general replay.

### addressed: Per-record warning fan-out defeats the transcript reader's work budget

- Original: major at `src/core/transcript/drops.ts:44-51`, `src/claude/transcript/emit.ts:38-50`, `src/codex/transcript/emit.ts:26-41`, `src/claude/transcript/index.ts:25-26`, and `src/codex/transcript/watcher.ts:23-24`.
- Evidence: The contract explicitly coalesces pathological drops per `(path, cause)` per scan at `PRD.md:1509-1516`. `DropReporter` accumulates one notice per key and clears before bounded delivery at `src/core/transcript/drops.ts:38-77`; Claude flushes once per scan/poll at `src/claude/transcript/index.ts:75-83` and `src/claude/transcript/index.ts:99-117`; Codex flushes once per scan at `src/codex/transcript/watcher.ts:75-87`.
- Verification: The focused regressions exercise 1,000 malformed reports collapsing to one notice, distinct keys, later-pass recurrence, and throwing sinks at `tests/unit/transcript-drops.test.ts:37-105`, with Codex adapter aliases covered at `tests/unit/codex-transcript-drops.test.ts:24-61`; both suites passed in the 10-file / 57-test run.
- Rationale: The implementation chose the review's permitted coalescing remedy and revised the specification accordingly. Pathological input no longer causes one synchronous warning/activity fan-out per malformed record while fresh incidents remain observable on later passes.

### addressed: The adapters duplicate a subtle live-warning router

- Original: major at `src/claude/session-transcript.ts:60-81` and `src/codex/session-transcript.ts:47-68`.
- Evidence: Clear-before-delivery buffering, lazy sink resolution, and listener containment now live in `createTranscriptWarningRouter` at `src/core/transcript/warning-router.ts:27-52`. Claude delegates to it at `src/claude/session-transcript.ts:61-73`, and Codex delegates at `src/codex/session-transcript.ts:48-62`.
- Verification: Claude and Codex wiring/lifecycle suites passed in the 10-file / 57-test run, including lone pre-sink warnings, clear-before-throw behavior, active throwing sinks, and persistent listener failures.
- Rationale: The nontrivial live-warning routing contract has one shared implementation; adapter modules supply only warning builders, sink lookup, and adapter-specific activity projection.

### addressed: Socket-home ownership depends on a duplicated magic prefix

- Original: minor at `src/state/runtime-paths.ts:38` and `src/state/socket-home.ts:9-16`.
- Evidence: `SOCKET_HOME_PREFIX` is defined once at `src/state/socket-home.ts:9-18`, imported by creation at `src/state/runtime-paths.ts:13-14`, and used by `mkdtempSync` at `src/state/runtime-paths.ts:40-48`; removal uses the same constant through `ownsSocketHome` at `src/state/socket-home.ts:16-28`.
- Verification: `rg` confirmed that production creation and ownership checks share this export; the focused state-store cleanup tests passed.
- Rationale: Creation and deletion can no longer drift through separately spelled production prefixes.

## Commands

- `git status --short --branch --untracked-files=all` — before writing this report, the only worktree change was the pre-existing deletion of `VALIDATION.md`; no staged or untracked changes were present.
- `git log --oneline --decorate df6acf2ec8b95234e8088cfb8e9527f4038746af..HEAD`, `git diff --name-status ...`, and `git diff --stat ...` — inspected the four post-review remediation commits and their 72-file change set.
- `git diff --check df6acf2ec8b95234e8088cfb8e9527f4038746af..HEAD` — passed.
- Read-only `sed`, `nl`, and `rg` traces over `REVIEW.md`, `PRD.md`, `README.md`, `CHANGELOG.md`, current source, and focused tests — completed; the source-comment searches found the remaining count/tracker wording cited above.
- `npm run typecheck` — passed.
- `npm run lint` — passed; Biome checked 465 files with no fixes.
- `npm run check:lines` — passed; all checked files are at or below 200 lines.
- `TMPDIR=/private/tmp XDG_CACHE_HOME=/private/tmp/elwood-validation-xdg ./node_modules/.bin/vitest run <10 non-socket focused files> --no-cache --no-file-parallelism` — passed: 10 files, 57 tests.
- `TMPDIR=/private/tmp XDG_CACHE_HOME=/private/tmp/elwood-validation-xdg ./node_modules/.bin/vitest run <15 focused files including adapter session tests> --no-cache --no-file-parallelism` — 61 passed and 18 failed across 15 files; every failure occurred at real hook-bridge startup with `hook_bridge_failed` before the targeted adapter assertion, consistent with Unix-socket binding being unavailable in this sandbox.
- `./node_modules/.bin/vitest --help` — passed; used to confirm the no-cache invocation.

## Residual Risks

- The sandbox could not execute the real-socket portions of the Claude/Codex adapter regressions. Their current code and checked-in assertions were traced, and shared unit paths passed, but a permissive environment should rerun the full focused adapter set.
- Several test descriptions also retain obsolete persistence wording, for example `tests/claude/session-transcript-drops.test.ts:4-16`, `tests/unit/codex-session-transcript.test.ts:108-120`, `tests/unit/codex-transcript-watcher.test.ts:6`, and `tests/unit/transcript-warnings.test.ts:18`. These did not change the original source-documentation status, but they can mislead future maintainers.
