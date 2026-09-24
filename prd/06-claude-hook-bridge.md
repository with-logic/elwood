## 6. Claude Hook Bridge

### 6.1 Required hook coverage

Elwood MUST configure a hook bridge for every Claude Code hook event supported
by the installed Claude Code version, including at minimum:

- `SessionStart`
- `Setup`
- `InstructionsLoaded`
- `UserPromptSubmit`
- `UserPromptExpansion`
- `PreToolUse`
- `PermissionRequest`
- `PostToolUse`
- `PostToolUseFailure`
- `PostToolBatch`
- `PermissionDenied`
- `Notification`
- `SubagentStart`
- `SubagentStop`
- `TaskCreated`
- `TaskCompleted`
- `Stop`
- `StopFailure`
- `TeammateIdle`
- `ConfigChange`
- `CwdChanged`
- `FileChanged`
- `WorktreeCreate`
- `WorktreeRemove`
- `PreCompact`
- `PostCompact`
- `SessionEnd`
- `Elicitation`
- `ElicitationResult`

If a future Claude version adds events, the MVP may reject them as invalid hook
input and fail open until first-class types are added. Elwood should add an
unknown-but-safe event path before promising forward-compatible hook handling.

`StopFailure` identifies a rejected Claude turn even when diagnostic fields drift.
After validating the common hook envelope, ingress MUST admit missing or arbitrarily
shaped `error`, `error_details`, and `last_assistant_message` fields. Their public
TypeScript types are optional `unknown`; consumers must narrow them before use.
Other event schemas retain their existing validation.

Human-readable rejection diagnostics prefer a nonblank string `error_details`, then
`Claude rejected the turn: <error>` for a nonblank string `error`, and otherwise
`Claude rejected the turn.`. Each diagnostic field is bounded to 2,000 characters
plus an ellipsis before interpolation. Assistant text is not a rejection reason.

### 6.2 Routing

Each launched Claude process receives an Elwood session identifier in its
environment as `ELWOOD_SESSION_ID`. The hook bridge reads that identifier and
uses it to route hook invocations to the owning Elwood runtime over local IPC.

The IPC transport is an implementation detail, but it MUST be local-only and
session-scoped. A Unix domain socket is the preferred initial design on macOS.
The bridge must authenticate or validate that it is talking to the expected
local Elwood runtime, for example through an unguessable per-session token stored
in the generated settings/environment.
Bridge request framing must wait for a complete request before dispatching. A
partial JSON chunk must not be interpreted as a complete hook invocation, and a
malformed complete request must fail open with a typed hook error.
A request with a missing or mismatched session token must also fail open without
dispatching to parent handlers. Token mismatches are treated as unauthenticated
local IPC noise, not as hook handler failures.

### 6.3 Fail-open behavior

The hook bridge is fail-open by default.

If no parent handler is registered for a hook event, Elwood returns the same
observable result Claude would receive if no hook existed.

If the bridge cannot identify a hook event name from malformed input, Elwood
emits `hookError.hookEventName: "Unknown"` and fails open.

If a handler times out, throws, rejects, disconnects, or returns an invalid
runtime value, Elwood returns no decision to Claude and emits `hookError` to the
parent app.

When a `Stop` result is finalized (normal completion, timeout, or other fail-open),
its registered handler and hook-scoped observers of `hook`, `activity`,
`hookError`/`hook_error`, and `hook_observer_failed` diagnostics lose authority
in their async continuations to admit new queue-backed input to that same live session.
Later `sendPrompt`, `sendMessage`, or `sendGuidance` calls from that context reject with
`wait_timeout` before image capture, attachment, or queue admission, including the
lazy session facade. The boundary identifies the live runtime instance, so another
adapter or state directory may reuse the same Elwood ID without sharing authority.
Already admitted input remains valid; the bridge does not wait for unawaited observers
or timed-out user code. Unrelated caller contexts, other sessions, non-Stop hooks,
raw keys, and independent non-turn controls are unaffected. Internal queue
notifications and persistent transcript polling do not inherit this authority.

Fail-open does not mean silent. `hookError` must include:

- `elwoodSessionId`
- hook event name
- error category
- timeout duration when applicable (only for a genuine timeout, never for a
  handler that throws or rejects)
- a diagnostic message

It must not persist the full hook payload by default.

Elwood's `hookTimeoutMs` is the deadline that decides a handler timeout. The
per-hook `timeout` written into the generated Claude settings (the CLI's own
kill switch for the hook process) is `ceil(hookTimeoutMs / 1000) + 5` seconds:
the CLI's clock starts when it spawns the hook process, before the bridge has
connected and Elwood's deadline has started, so an equal value would let the CLI
kill the hook just before Elwood's fail-open "no decision" reply arrived. The
margin keeps Elwood the party that times out, so the parent always observes its
typed `hookError` rather than an opaque CLI-side hook failure.

The bridge caps the size of a single hook request at 8 MiB (8,388,608 bytes). The
cap is measured on the SAME thing in both places: the encoded wire envelope (the
`{token, elwoodSessionId, input}` JSON plus its framing newline), counted in the
child bridge script before it connects and in the parent IPC server as bytes
arrive — so an escape-heavy input whose JSON encoding expands past the ceiling is
rejected identically by both, never accepted by the child only to be dropped by
the server. The child additionally bounds raw stdin buffering at the same ceiling
as an OOM guard (the wrapped envelope can only be larger, so raw input past the cap
can never yield a valid request). The cap is enforced before any authentication or
parsing. A request whose encoded envelope exceeds the cap fails open immediately:
the child bridge script emits no decision and exits, and the parent server responds
with no decision and closes the connection without dispatching to any parent
handler. An oversized request is unauthenticated local IPC noise and does not emit
a `hookError`, matching the token-mismatch fail-open.

### 6.4 Typed hook responses

Observational listener failures must not prevent Claude hook dispatch, replace a
validated wire response or blocking decision, or skip readiness and Stop bookkeeping.
Hook, activity, hook-error, transcript, and lifecycle notifications are isolated at
the hook boundary. Each invocation emits at most one content-free
`hook_observer_failed` warning (§5.7), identifying the first failed phase; warning
observer failures are contained without recursive diagnostics (C-HOOK-22).
Returned native observer Promises are observed through the captured intrinsic
`Promise.prototype.then`, without awaiting them or reading an instance's own `then`.
Their rejections are contained even after the hook reply completes when their
constructor and `Symbol.species` support normal ECMAScript reaction attachment.
Listeners run in the host process, not a sandbox: nonreturning synchronous listener
code or Promise metadata can block the host. A constructor/species that prevents
native attachment leaves its rejection handling with the caller. An attachment
throw is reported as a notification failure, without caching an unattached Promise;
a subsequent notification retries attachment. Elwood neither mutates caller Promise
metadata nor opens a debugger session to bypass it. The first observed failure
selects the diagnostic phase, and late failures do not emit additional warnings.
Diagnostic retention is limited to the newest 1,024 pending observer registrations
per session emitter. When this cap is exceeded, the oldest registration is detached
from its invocation boundary; its eventual rejection is still consumed but no
longer produces a diagnostic. Repeated returns of the same pending Promise share
one rejection handler. Settled registrations are released immediately. Diagnostic
warnings are frozen before delivery, and their activity projection is captured
before any warning listener runs.
Within a hook notification scope, synchronous listener failures are captured at
each emission, so later derived status activity and committed transcript records
are still delivered. Outside this scope, ordinary synchronous emission retains
its existing throw-after-fan-out behavior. A hook-scoped ready-status listener
failure reports `hook_observer_failed`; because the ready transition completes, it
does not also report `initial_ready_fallback`. C-API-42 still applies to a transition
that actually throws outside the notification boundary.

Elwood MUST model Claude hook inputs and outputs as discriminated TypeScript
unions.

- `hook_event_name` narrows the event payload.
- For tool events, `tool_name` narrows `tool_input` and response shape.
- Known Claude built-in tools must be typed as strongly as Claude's documented
  schemas allow.
- Unknown future tools and MCP tools may use `Record<string, unknown>` or
  `unknown` with a safe raw tool name.
- Hook bridge JSON must be runtime-validated before it reaches handlers.
  The normalized, bridge-owned JSON event is deeply frozen before any observation
  or handler dispatch. Hook observers and activity raw payloads cannot mutate
  routing, tool inputs, response validation, or readiness/Stop bookkeeping.
  Freezing introduces no additional input depth or size limit beyond the bridge
  request contract.
- A numeric field MUST be a finite number. `NaN` and `±Infinity` are rejected at
  ingress and in `updatedInput` rewrites, because JSON has no encoding for them
  and `JSON.stringify` would put a `null` on the wire where the CLI's schema
  requires a number. This applies to EVERY tool: schema-less inputs (MCP, generic,
  and future tools) have no field table, so the rule is enforced structurally over
  the whole value, including nested records and arrays. Traversal allows at most
  128 edges from the input root and 100,000 value visits, counting the root,
  primitives, and every occurrence of a shared child. Ancestor cycles are invalid;
  repeated children on separate paths are valid within these limits. Cyclic or
  over-limit shapes fail validation without throwing. Invalid rewrites produce the
  existing `invalid_response` hook error and a bridge response with no decision.
  Structural values must consist of null, strings, booleans, finite numbers,
  arrays, and plain records (including null-prototype records). Undefined values
  retain JavaScript JSON omission/null semantics. Bigints, functions, symbols,
  boxed primitives, proxies, custom prototypes, callable `toJSON` hooks, and
  enumerable accessor properties are invalid. Other non-enumerable fields are
  ignored; validation does not invoke getters or custom serializers. Each
  child's budget is checked before reading its property descriptor. The complete
  response envelope independently obeys the snapshot limits below.
- Before result validation, Claude handler responses are copied into detached data.
  Validation and wire serialization use that same snapshot, so later handler mutation
  cannot replace a validated rewrite. Wire output and blocking decisions are captured
  before result activity observers run. Only genuine Promises are awaited; direct
  response-shaped thenables are validated as data without invoking `then`. Snapshotting reads only own enumerable data
  properties, never invokes accessors or serializers, and rejects proxies, boxed
  primitives, non-finite numbers, bigints, functions, symbols, custom prototypes,
  and cycles. Null-prototype records are valid. Non-callable `toJSON` data fields
  are ordinary data; callable or accessor-backed serializers are invalid even when
  non-enumerable. Other non-enumerable properties are ignored as they are by JSON.
  Undefined values and array holes retain JSON omission/null semantics. Responses
  are limited to 128 edges on each root-to-leaf path (the root is depth zero) and
  100,000 value visits, counting the root, undefined values, array holes, and
  repeated occurrences of shared children. Invalid snapshots yield `invalid_response`
  and no bridge decision (C-HOOK-21). Claude response wrappers across async dispatch
  and the socket reply envelope do not inherit `then` or `toJSON` behavior.

Task and plan inputs follow Claude's documented native field names: `TaskGet`
uses `taskId`; `TaskOutput` uses `task_id`, `block`, and `timeout`; `TaskStop`
accepts optional `task_id` and the deprecated `shell_id`. `CronDelete` uses `id`.
`ExitPlanMode.allowedPrompts` contains `{ tool: "Bash", prompt: string }` objects,
not strings. These shapes apply to both ingress and partial input rewrites.
See the [Claude tool reference](https://code.claude.com/docs/en/agent-sdk/typescript#tool-input-types).

Invalid states should be unrepresentable where TypeScript can enforce that. For
example, a `Notification` handler should not be able to return a blocking
decision, while a `PreToolUse` handler can return `allow`, `deny`, `ask`,
`defer`, `updatedInput`, and/or `additionalContext` according to Claude's rules.
`PreToolUse` may also return `additionalContext` without a permission decision.
Typed `updatedInput` rewrites MUST be authored through a tool-keyed handler such
as `PreToolUse.Bash` or `PreToolUse.AskUserQuestion`, so the returned input
rewrite is checked against that exact tool's input type. The event-name
`PreToolUse(event)` handler form may return permission decisions or context, but
must not expose `updatedInput`. Elwood must also validate returned
`updatedInput` against the actual tool input shape for known tools before
serializing it.

Claude hook response support also includes:

- `PermissionRequest` may return `allow` or `deny`, optional `updatedInput`,
  `updatedPermissions`, `message`, or `interrupt`.
  Typed `updatedInput` rewrites follow the same tool-keyed handler rule as
  `PreToolUse`.
- `PermissionDenied` may return `{ retry: true }`.
- context hooks such as `SessionStart`, `Setup`, and `SubagentStart` may return
  `additionalContext`, `initialUserMessage`, or `watchPaths`.
- `PostToolUse` may return `additionalContext`, `updatedToolOutput`, or
  `updatedMCPToolOutput`, or block with a reason. Every field is optional, so
  an empty object is a valid no-op result (as it is for the context hooks).
- `WorktreeCreate` may return `{ worktreePath: string }`.
- `TeammateIdle`, `TaskCreated`, and `TaskCompleted` may return
  `{ continue: false, stopReason? }`.

### 6.5 Readiness

The `Stop` hook is the canonical signal that a Claude turn completed and the
session is ready for the next prompt. If a `Stop` handler blocks stopping and
returns feedback to Claude, Elwood must not mark the session ready.

The headless terminal screen model may be used for startup automation,
environment warnings, diagnostics, or UI hints. On a **cold start** it is not the
source of truth for readiness — a rendered composer there is only a placeholder
and the hook/deadline path decides readiness. **On resume this is relaxed** (see
§5.3 and C-API-28): because the input loop is already live, the first rendered,
quiet, non-blocking composer frame is an accepted readiness source, racing the
readiness hook and the deadline. A blocking dialog on that frame does not mark
ready.
