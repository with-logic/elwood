# Native agent questions

Elwood exposes structured questions from the real Claude Code and Codex terminal
interfaces. A host such as Coal Harbor renders the questions, collects answers,
and calls Elwood to submit them through the native editor.

Subscribe before starting a turn. Keep the question handler active while awaiting
`send()` or consuming `stream()`; a blocking question needs an answer before that
turn can finish.

```ts
import { ClaudeSession, type ElwoodQuestionAnswer } from "@with-logic/elwood";

const session = new ClaudeSession({ cwd: "/path/to/project", autotrust: true });

session.on("question", (event) => {
  if (event.phase === "raised") showQuestionRequest(event.request);
  else removeQuestionRequest(event.request.id, event.reason);
});

// After the user fills every question in one request:
async function submit(requestId: string, answers: readonly ElwoodQuestionAnswer[]) {
  await session.answerQuestions(requestId, answers, { timeoutMs: 20_000 });
}

const reply = await session.send("Help me choose and implement the right approach.");
```

The same methods and event exist on `CodexSession`, the low-level adapter
interfaces, and the shared `ElwoodAgentSession` interface. Lazy session controls
start their session when needed. A late subscriber can reconcile its UI with
`await session.listQuestions()`, an immutable list of all pending requests in
discovery order. Subscribe first and buffer lifecycle events while loading the
snapshot; install the snapshot, then replay those buffered edges by request ID.
This prevents a request closed during loading from reappearing in the UI.

## Request and answer contract

A request contains an opaque `id`, `agent`, `delivery` (`blocking` or `queued`),
and ordered `questions`. Each question contains:

- An opaque `id`, `prompt`, optional `header`, and ordered `options` with opaque
  IDs, labels, and optional descriptions.
- `selection`: `single`, `multiple`, or `none`.
- `textMode`: `none`, `alternative` (text instead of a choice), or `additional`
  (text may accompany a choice).
- `secret`: whether the supported native editor accepts secret input. Current
  characterized editors advertise `false`; do not infer masking from model text.

Render these capabilities as supplied. Send one complete batch for one request:

```ts
const [request] = await session.listQuestions();
if (request) {
  const answers: readonly ElwoodQuestionAnswer[] = await collectUserAnswers(request);
  await session.answerQuestions(request.id, answers);
}
```

For a choice, use `{ questionId, optionIds: userSelectedOptionIds }`. For text,
use `{ questionId, text: "The user's answer" }`. For multiple choice, pass all
selected `optionIds`. Include both only when `textMode` is `additional`.
Every question in the selected request needs exactly one answer; the host chooses
when to submit. Elwood never selects defaults or answers automatically.

Unknown or duplicate IDs, missing answers, unsupported combinations, empty
answers, and unsafe control characters reject before any input. Multiline text
uses bracketed paste. Invalid answers produce `invalid_question_answer`; stale
or closed request IDs produce `question_not_found`. Do not retain request IDs
across process restarts or resume.

## Lifecycle and input ownership

The typed `question` event has `phase: "raised"` or `"closed"`, plus the request,
agent and session ID. Closure reasons are `answered`, `cancelled`, and
`unavailable`. `answered` means native acceptance was observed. Turn completion,
withdrawal, replacement or shutdown uses `unavailable` unless stronger native
evidence exists. Redraws and mirrored source records do not raise duplicates.

The normalized activity stream carries the same event in `activity.question`
with `kind: "question"`. Hosts can consume either surface; deduplicate by request
ID if listening to both. Question activities contain the question metadata, not
the user's submitted answers. They are separate from final assistant text and
excluded from ergonomic reply text.

Answering uses a dedicated input lane and works while another send or turn is
waiting. Pending questions hold ordinary text, slash commands, loops and login
writes so those cannot enter the question editor or erase queued questions.
`delivery: "queued"` can coexist with an agent that is still working. Question
availability alone does not mean its turn has finished.

An answer call resolves after native acceptance. The default timeout is 20
seconds; pass a positive finite `timeoutMs` or an `AbortSignal` as `signal` to
bound the operation. Concurrent answer calls, human keyboard takeover,
interruption, shutdown, layout changes, rejected input or uncertain acceptance
reject with `question_answer_failed`. A submitting Enter is never blindly
retried. After failure, refresh `listQuestions()` and the terminal view before
letting the user retry; some native selections may already have changed.

Requests and answers are live-only and are not added to Elwood's persisted state.
Existing raw hooks and transcripts retain their normal contents and can include
answers. Avoid logging them if your host treats those answers as sensitive.

## Native differences

Claude's `AskUserQuestion` can group tabbed questions into one request, including
single choice, checkboxes and alternative text on single-select questions.
Checkbox questions currently advertise `textMode: "none"`. Elwood submits the group through
its review page. A caller's direct Claude hook answer keeps precedence and does
not create a phantom terminal question. The supported automation starts from the
recognized first question; unsupported partial navigation fails safely. Completion
hooks must match the native request ID, or its ordered question definitions when
the hook omits that ID. Unrelated Claude hooks cannot acknowledge the request.

Codex's modal `request_user_input` groups questions into one acceptance unit.
Its current editor requires choices for every question; native Other/notes
supports a custom answer, and the native “None of the above” row is exposed as
its own option. Notes can accompany a selected choice. Queued
`request_user_input_async` questions are accepted
individually, so Elwood exposes one request per independently answerable question,
even if the agent asked several at once. They can disappear when the native turn
ends. Elwood does not extend their lifetime or invent a fixed expiry. Native Codex
metadata must omit `isSecret` or use boolean `false` for every question; unsupported
or malformed secret flags leave the complete request unavailable for automation.

Ordinary prose questions, permission prompts, trust gates, model pickers and login
flows retain their existing surfaces. Unknown question layouts remain available
through the terminal view and do not receive guessed answer keys. Native behavior
was characterized on Claude Code 2.1.305 and Codex 0.163.0; see
[CLI behavior](cli-behavior.md#native-interactive-questions-2026-10-20) for evidence.

Codex question automation is bounded to 256 pending native requests and 1 MiB
of candidate metadata; each call is limited to 256 definitions and 1 MiB of
input metadata. Replay protection retains at most 4,096 retired identities and
1 MiB of key data. Overflow closes exposed requests as `unavailable` and disables
question automation until a new session is created. You can continue with raw
human input; ordinary input is held only while native question UI is visible.
Unanswered requests have no invented expiry deadline.
