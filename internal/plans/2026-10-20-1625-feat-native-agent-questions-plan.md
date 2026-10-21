---
title: Native agent questions - Plan
type: feat
date: 2026-10-20
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---
# Native agent questions - Plan

Historical implementation plan for the 0.2.0 release. The implemented contract
is in `prd/05-api/5.10-questions.md`; native proof commands and assertions are
in `docs/native-question-proofs.md`.

## Goal Capsule

- Objective: Host applications can show and answer native Claude and Codex questions instead of trying to prevent the agents from asking them.
- Means: Shared live question snapshots, lifecycle events, and guarded native answer controls.
- Authority: The user's request defines the outcome; `prd/` owns the implemented public contract; Coal Harbor owns its presentation and chat mapping.
- Execution: Characterize real native flows before changing behavior, then implement and verify both adapters locally.

---
## Product Contract

### Summary

Expose native structured questions and their supported answer capabilities through one Elwood API.
Keep questions distinct from assistant replies and keep asynchronous question availability independent of session readiness.

### Problem Frame

Coal Harbor tries to suppress agent questions because it cannot currently present or answer them reliably.
Agents still ask, leaving users with a terminal-specific question editor that the host cannot control.
Codex can hide questions under its queued-follow-up badge; Claude supports choices and tabbed question sets.

### Requirements

**Discovery and lifecycle**

- R1. Both adapters expose complete live question requests, including ordered prompts, headers, choices/descriptions, selection multiplicity, and supported free-text/secret capabilities.
- R2. Typed question events and normalized question activities share opaque live request/question/option identities; a current-request snapshot supports late subscribers.
- R3. Redraws and source mirrors do not duplicate requests, and native answers, dismissal, expiry, replacement, and shutdown retire requests when supported by authoritative evidence.
- R4. Claude and blocking Codex multi-question dialogs form a grouped request; each independently accepted Codex asynchronous question is its own request.

**Answering and turn ownership**

- R5. A common answer control validates one complete request before typing and supports native single choice, multiple choice, free text, and multi-question navigation.
- R6. Answer controls work during an in-flight ergonomic turn and while ordinary input is held, resolve on native acceptance, and reject stale/invalid requests without typing.
- R7. Questions and their answers do not become final assistant replies or falsely complete the original ergonomic response; Codex queued questions may remain available while the agent continues working.
- R8. Human keyboard intervention and unrelated native dialogs revoke answer automation; ordinary prompts, commands, loops, and login input must not enter a question editor.
- R9. Question payloads and answers remain live-only and are not added to Elwood's persisted session state.

### Scope Boundaries

Native structured question tools and their terminal editors are in scope, including existing direct Claude hook answers.
Coal Harbor application changes, automatic answer policies, parsing ordinary prose as actionable questions, and a new Elwood-authored questionnaire system are outside this change.
Draft persistence and a cross-request atomic batch protocol were considered and are not built: native question editors have different acceptance units and the host can collect answers before calling Elwood.

### Assumptions

The host will render questions and collect answers using the advertised capabilities.
Unsupported or changed terminal layouts must remain observable through existing terminal/attention surfaces and fail answer automation without speculative writes.
Native questions can expire or be withdrawn before the host answers; the API reports current availability rather than extending native lifetimes automatically.

---
## Planning Contract

### Key Technical Decisions

- KTD1. Recover structured content from native Claude tool hooks and committed Codex transcript records, then confirm the current terminal editor before answering (R1–R6).
  Claude's `AskUserQuestion` input already carries the entire batch; Codex's question badge alone carries no text.
  Codex's transient `request_user_input` event is not a durable discovery source, so use persisted tool-call arguments and proven async message metadata.
- KTD2. Answer through a dedicated guarded physical-input transaction rather than an ordinary readiness-queued send (R6, R8).
  `src/core/control-queue/index.ts` retains one in-flight operation, and a blocked ordinary writer can already own it; enqueueing the answer behind that writer deadlocks.
  Reuse current completed-render and raw-input revocation mechanisms in `src/runtime/session/picker-input.ts`.
- KTD3. Do not park the standard Claude hook awaiting a human (R5, R6).
  `src/claude/session/hook-handler.ts` uses the existing 25-second fail-open hook deadline; preserve direct caller hook policy answers and answer surviving native dialogs through their terminal flow.
- KTD4. Keep a small shared request registry and validation layer with provider-specific observation and answer drivers (R1–R9).
  Request IDs are scoped to the live process instance; semantic replacement invalidates prior answer authority.
  Grouping follows R4 so there is no false cross-question atomicity guarantee for independently accepted asynchronous inputs.
- KTD5. Preserve native lifecycle evidence rather than guessing that a fulfilled Enter means answered (R3, R6, R7).
  An uncertain write/acknowledgement fails the answer operation and preserves whatever pending state is still evidenced; it never retries a submitting Enter blindly.

### System-Wide Impact

Update common and concrete session interfaces, lazy facade delegation, event maps, normalized activity types, and public exports together.
New question telemetry stays outside ergonomic content projection.
Question holds must compose with startup trust, approvals, model pickers, cleanup, and ongoing selected-turn ownership.
Split helpers before existing session/build files exceed 200 lines.

### Deferred to Implementation

U1 establishes exact current record shapes, keyboard sequences, cancellation/acceptance signals, native expiry behavior, and mixed multiple-choice/freeform support.
These are runtime characterization tasks, not permission to replace the interactive CLI with an SDK or app-server transport.
The supported grammar and PRD details follow the captured evidence before production implementation.

---
## Implementation Units

### U1. Establish native question behavior

**Goal:** Capture the actual request-to-answer lifecycle in current Claude 2.1.305 and Codex 0.163.0.
**Requirements:** R1, R3–R8.
**Dependencies:** None.
**Files:** `tests/fixtures/claude-2.1.305/questions/`, `tests/fixtures/codex-0.163.0/questions/`, focused helpers/tests under `tests/e2e/`, `docs/cli-behavior.md`.
**Approach:** Use private CLI homes/projects and real PTYs to observe grouped/tabbed Claude questions and Codex queued plus blocking questions; retain sanitized native records/screens and answer outcomes.
**Execution note:** Prove that the intended answer reaches the native tool/model, rather than accepting keystroke assertions as proof.
**Patterns to follow:** `tests/e2e/codex-response-sandbox.ts`, `tests/e2e/codex-commentary.e2e.ts`.
**Test scenarios:** Single choice; multiple selection; free text; grouped questions; queued asynchronous questions while working; native answer/dismissal/expiry; genuine running/ready continuation.
**Verification:** Captures identify complete question content, the exact supported answer route, and authoritative lifecycle acknowledgements without modifying parent CLI configuration.

### U2. Expose and answer Claude questions

**Goal:** Deliver the shared live question contract with a complete Claude implementation.
**Requirements:** R1–R9.
**Dependencies:** U1.
**Files:** New `src/core/questions/` and `src/claude/questions/` modules; `src/core/types.ts`, `src/core/activity/index.ts`, `src/core/agent-session.ts`, `src/core/simple/session.ts`, `src/claude/session/interface.ts`, `src/claude/session/hook-handler.ts`, session/build integration helpers, `src/index.ts`; matching `tests/unit/questions/` and `tests/claude/session-questions*.test.ts`; relevant `prd/05-api/`, `prd/07-claude-policy.md`, `prd/08-state.md`, `prd/10-errors.md`, `prd/14-conformance.md`.
**Approach:** Specify the shared immutable request/answer/error contract first, implement registry and owned answer transaction, then wire Claude hooks/native frames, public interfaces and facade delegation.
**Patterns to follow:** Current model-picker transaction and revocation helpers, attention/readiness gates, tool-specific hook validation.
**Test scenarios:** Full typed request; direct hook answer precedence; tabbed single/multiple/free-text answers; late subscription; duplicate redraw; quoted text; stale/foreign IDs; invalid complete batch performs zero writes; already-held ordinary writer; concurrent answer calls; human takeover; shutdown; unsupported/partial frame; failed write/uncertain acknowledgement; original ergonomic turn continues and produces one final reply.
**Verification:** Existing Claude hook and input-ownership tests remain green; new behavior fails without the feature; executable changed code reaches full coverage.

### U3. Expose and answer Codex questions

**Goal:** Support synchronous and queued asynchronous Codex questions through the shared contract.
**Requirements:** R1–R9.
**Dependencies:** U1, U2.
**Files:** New `src/codex/questions/` modules; `src/codex/session/transcript.ts`, `src/codex/session/types.ts`, session/build integration helpers, `src/codex/transcript/summary.ts`; `tests/unit/codex-questions*.test.ts`, `tests/codex/session-questions*.test.ts`; Codex sections of `prd/05-api/`, `prd/07a-codex-hook-bridge.md`, `prd/14-conformance.md`.
**Approach:** Normalize proven persisted requests and acceptance/withdrawal evidence, correlate mirrors, and drive the confirmed native editor for the selected live request.
**Patterns to follow:** U2's shared question controller; existing Codex transcript warning isolation and native model-driver framing.
**Test scenarios:** Collapsed badge discovery with full text/options; open and answer the selected queued question; freeform and grouped blocking questions; independently accepted async requests; mirrored records; native expiry/dismissal/human answer; no false final from question-bearing asynchronous messages; blocked queue and original ergonomic collector remain owned; stale request after same-ID resume performs zero writes.
**Verification:** Existing Codex final/commentary and readiness behavior remains green; native proof confirms answers are accepted without ordinary prompt misrouting.

### U4. Document and verify consumer usage

**Goal:** Make the question contract usable by CH and prove the integrated feature.
**Requirements:** R1–R9.
**Dependencies:** U2, U3.
**Files:** `CHANGELOG.md`, `README.md`, new `docs/questions.md`, adapter docs, `docs/cli-behavior.md`, native E2E tests from U1.
**Approach:** Document event/snapshot/answer usage, input ownership, native availability, and CH's responsibility for rendering and collecting answers; complete native proofs through the public API.
**Test scenarios:** Host-style event subscription plus late snapshot; multiple requests in order; both providers answer and continue; unchanged parent environments and CLI configuration.
**Verification:** The full repository gate and opt-in native question proofs pass, with actual counts and coverage reported.

---
## Verification Contract

Run focused tests alongside each provider implementation, including deliberate removal of each fix to establish that its regression test fails.
Run all components of `npm run check`: build, strict typecheck, Biome, 200-line cap, and the complete Vitest suite with 100% statements, branches, functions, and lines.
Use bounded workers when machine load warrants it and require actual test counts.
Run the native question proofs serially in isolated homes/projects; preserve parent auth/config/hook files and environment and clean up every owned process.

---
## Definition of Done

Both native question families are observable and answerable through the public shared API, including the queued Codex case from the request.
The PRD, implementation, tests, changelog and consumer documentation agree.
All required tests/checks pass and every code file stays under 200 lines.
Only work-owned changes are committed locally; existing commits are not published without a shipping request.

## Sources

- `src/claude/hooks/tool-types.ts`, `src/claude/session/hook-handler.ts`, and `tests/claude/session-hooks.test.ts` establish the current typed Claude hook seam.
- `src/core/control-queue/index.ts` and `src/runtime/session/picker-input.ts` establish queue ownership and physical-input revocation.
- [Claude hooks: tools requiring interaction](https://code.claude.com/docs/en/hooks#tools-that-require-user-interaction).
- [Codex 0.163.0 native question navigation](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/tui/src/chatwidget/questions.rs).
- [Codex 0.163.0 async question state](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/tui/src/bottom_pane/async_questions/state.rs).
