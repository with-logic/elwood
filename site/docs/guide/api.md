# TypeScript API reference

Import from `@with-logic/elwood`. The primary entry points are `ClaudeSession` and `CodexSession`. They share an ergonomic turn API and expose the operational methods of the underlying session.

## Constructors

```ts
import { ClaudeSession, CodexSession } from "@with-logic/elwood";

const claude = new ClaudeSession({ cwd: process.cwd() });
const codex = new CodexSession({ cwd: process.cwd() });
```

Construction is synchronous and snapshots the working directory. The first turn or `start()` launches the agent. Omitting `cwd` uses the working directory at construction time.

## Constructor options

| Common option | Type / meaning |
| --- | --- |
| `cwd` | Workspace path; defaults to `process.cwd()` |
| `stateDir` | Elwood session-state directory |
| `model` | Agent-supported model identifier |
| `reasoningEffort` | Agent-specific effort level |
| `persona` | Setup prompt |
| `initialSize` | Terminal dimensions, `{ cols, rows }` |
| `autoupdate` | Opt into the adapter's update behavior |
| `autotrust` | Control allowlisted trust automation |
| `highTrust` | Never ask for permissions: Claude `bypassPermissions`, or Codex `danger-full-access` with `never` |
| `strictVersionCheck` | Reject an unparseable/unsupported version instead of permissive handling where supported |
| `hooks` | Agent-specific typed hook handlers |
| `hookTimeoutMs` | Timeout for hook handling |

Passing `highTrust` alongside an explicit `permissionMode` (Claude) or `sandbox`/`approvalPolicy` (Codex) throws `claude_high_trust_conflict` / `codex_high_trust_conflict` rather than silently overriding your choice.

Claude also accepts `name`, `permissionMode`, `allowedTools`, `disallowedTools`, `tools`, and `settingsOverrides`. Codex accepts `profile`, `sandbox`, `approvalPolicy`, and `configOverrides`. Use the exported `ClaudeSessionOptions` / `CodexSessionOptions` types for compiler-checked configuration.

CLI defaults and global config do not define library constructor defaults. Set important permissions explicitly in your application.

## Turn methods

| Method | Returns | Use |
| --- | --- | --- |
| `send(prompt, options?)` | `Promise<string>` | Wait for the combined assistant reply |
| `stream(prompt, options?)` | `AsyncGenerator<TurnEvent>` | Consume content as it arrives |
| `start()` | Promise of the underlying session | Eager startup; idempotent |

Ergonomic turns are serialized in call order on each session. Do not interleave low-level turn-producing methods with an in-flight `send()` or `stream()`.

## Turn options

```ts
await session.send("Explain this screenshot.", {
  timeoutMs: 120_000,
  catchUpMs: 10_000,
  images: [{ path: "/absolute/path/screenshot.png" }],
});
```

`timeoutMs` is an opt-in turn ceiling; there is no default. `catchUpMs` bounds transcript catch-up after ready, with a default of 10 seconds. A wait timeout is not a process kill.

Images accept either `{ path: string }` or `{ data: Uint8Array, format }`. Byte formats are `png`, `jpeg`, `gif`, and `webp`. Do not supply both path and bytes. Limits are 16 images per submission, 25 MiB per image and 50 MiB total; queued image bytes on one session also have a bounded aggregate limit.

## Stream events

| `type` | Fields |
| --- | --- |
| `text` | `text: string` |
| `thinking` | `text: string` |
| `tool_call` | `name: string`, optional `input`, `toolCallId` |
| `tool_result` | Optional `name`, `output`, `toolCallId` |

`input` and `output` are strings when present. Availability and granularity depend on the adapter. The stream finishes when that turn settles; stopping iteration does not stop the agent.

## Lifecycle and control

| Method | Behavior |
| --- | --- |
| `close()` | Stop, falling back to kill when needed; joins an in-flight startup |
| `stop()` | Delegate graceful stop to the live session |
| `kill()` | Force-stop the live session |
| `teardown()` | Remove Elwood-owned session state through the live session |
| `interrupt({ timeoutMs }?)` | Request interruption of current work |
| `compact({ timeoutMs }?)` | Request conversation compaction |
| `resize({ cols, rows })` | Change terminal dimensions |
| `listModels(options?)` | Inspect the agent's model choices |
| `setModel(id, options?)` | Switch model through the agent |
| `listQuestions()` | Read an immutable snapshot of pending native question requests |
| `answerQuestions(requestId, answers, options?)` | Submit one complete native question request |
| `waitForStatus(predicate, timeoutMs?)` | Wait for a matching lifecycle status |
| `waitForActivity(predicate, timeoutMs?)` | Wait for matching normalized activity |

`session.status` exposes current status. `session.session` is undefined before startup and holds the low-level session afterward. Raw identity and diagnostics such as `elwoodSessionId`, `cwd`, `terminal` and `statusDecisions()` live there.

## Events and hooks

`on(event, handler)` returns an unsubscribe function; `off(event, handler)` removes the matching subscription. Common events include `activity`, `status`, `warning`, `question`, `terminal:data`, `terminal:exit`, `hook` and `hookError`. Event names and payloads are typed per adapter.

Use constructor `hooks` when your application must respond to an agent hook. Use event subscriptions when it only needs to observe. Claude and Codex have different hook vocabularies and result types; do not reuse a handler blindly between agents.

The classes also expose `createLoop()`, `listLoops()` and `cancelLoop()` for recurring prompts, plus raw `sendMessage()`, `sendPrompt()`, `sendGuidance()` and `sendKeys()` for direct control. Raw input bypasses the ergonomic turn queue. Start with `send()` and `stream()` unless you need to own that coordination.

### Commentary and login renewal

Committed Codex commentary produces `activity.kind: "assistant_progress"` with readable `text`. Final answers retain `assistant_message`. Progress does not finish the turn or enter `send()` results or `stream()` text events; a host can display it separately while keeping its working state.

Claude's advance login-renewal notice produces a typed `login_expiring` warning with `expiresInDays` and `recoveryCommand: "/login"`, plus a matching warning activity. A host can offer renewal before the login expires. The notice does not change session status or start login automatically.

## Native questions

Both classes expose native question requests through typed `question` events and normalized activities with `kind: "question"`. A raised event contains the immutable request; a closed event identifies native acceptance, cancellation or unavailability. The host owns rendering and collecting answers.

Each request has opaque live IDs and ordered questions. Render its advertised `selection` and `textMode` capabilities, including choices, checkboxes and supported text. Claude and blocking Codex forms group questions into one request. Codex queued questions are independently answerable requests and can remain available while the agent works.

Subscribe before starting a turn and keep the question handler active while awaiting `send()` or consuming `stream()`. `listQuestions()` supports late subscribers; subscribe first, buffer events during snapshot loading, install the snapshot, then replay those events by request ID.

Pass `answerQuestions()` the request ID and one complete batch of `ElwoodQuestionAnswer` values. Each value uses `questionId`, optional `optionIds`, and optional `text`; include both choices and text only when `textMode` is `additional`. The default answer timeout is 20 seconds; options accept a positive finite `timeoutMs` and an `AbortSignal` as `signal`.

Answering uses a dedicated input lane while the original turn remains open. Pending questions hold ordinary prompts and commands. Invalid or stale answers reject before typing, and an answer call resolves only after native acceptance. Human keyboard intervention revokes automation. Unknown layouts remain visible through the terminal and receive no guessed answer keys. Codex metadata must omit `isSecret` or set it to boolean `false` for every question; unsupported or malformed flags prevent publication of the complete native request.

Codex automation retains at most 256 pending native requests and 1 MiB of candidate metadata; each call is limited to 256 question definitions and 1 MiB of input metadata. Replay protection retains at most 4,096 retired identities and 1 MiB of key data. Overflow closes exposed requests as `unavailable` and disables question automation for the rest of that session. Raw human control remains available; ordinary input resumes when the native question surface clears. These limits do not add an expiry deadline.

Requests are live-only and are not added to Elwood's persisted state. Existing raw hooks and transcripts can still contain answers. See the [complete question contract](https://github.com/with-logic/elwood/blob/main/docs/questions.md) for errors, native differences and consumer examples.

## Errors

The exported `ElwoodError` has `code`, `message` and `details`. Use `instanceof ElwoodError` before reading those fields. Typical codes include `claude_not_found`, `codex_not_authenticated`, `unsupported_platform`, `invalid_image`, `state_not_found`, `wait_timeout`, and `termination_failed`.

The CLI has its own terminal error records, including command-specific codes such as `blocked_prompt` and invocation timeouts. Do not assume every CLI code belongs to the library's `ElwoodErrorName` union.

## Advanced resume

`resumeClaude()` and `resumeCodex()` accept an `elwoodSessionId` and return the low-level session API. `startOrResumeClaude()` / `startOrResumeCodex()` provide a try-resume-or-start flow. These are a different surface from the ergonomic classes. The eager `startClaude()` and `startCodex()` factories are deprecated in favor of the classes.

For most projects, use a long-lived class instance for in-process follow-ups, or the [CLI continuation recipe](cli.html#resuming-a-session) for separate shell invocations.
