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
`await session.listQuestions()`, an immutable list of available requests in
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
- `supportsSecretInput`: whether the supported native editor accepts secret input. Current
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

Unknown or duplicate question/option IDs, missing answers, unsupported
combinations, empty answers, and unsafe control characters reject before any
input. Multiline text uses bracketed paste. The 8 MiB answer-batch limit is the
sum of UTF-8 bytes in validated question IDs, selected option IDs and text;
JSON syntax and unknown fields do not count. Text must contain well-formed
UTF-16. Invalid answers produce `invalid_question_answer`; unknown, stale, closed
or previous-process request IDs produce `question_not_found`. Do not retain
request IDs across process restarts or resume.

## Lifecycle and input ownership

The typed `question` event has `phase: "raised"` or `"closed"`, plus the request,
agent and `elwoodSessionId`. Closure reasons are `answered`, `cancelled`, and
`unavailable`. `answered` means native acceptance was observed. Turn completion,
withdrawal, replacement or shutdown uses `unavailable` unless stronger native
evidence exists. Redraws and mirrored source records do not raise duplicates.

The normalized activity stream carries the same event in `activity.question`
with `kind: "question"`. Choose one surface, or deduplicate matching deliveries
by request ID, phase and closure reason when listening to both. A request's
`closed` event must still be processed after its `raised` event. Question
activities contain question metadata, not the user's submitted answers. They are
separate from final assistant text and excluded from ergonomic reply text.

A throwing or rejecting `question` or matching `activity` handler produces at
most one content-free `question_observer_failed` warning per live session, plus
its normalized warning activity. Its `phase` is `question` or `activity`, naming
the first failing notification channel. Other handlers and question lifecycle
delivery continue. The diagnostic contains no question, answer or error contents;
it does not authorize retrying or replaying an answer.

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
retried. Failures may include a content-free `details.phase`: `frame_wait`,
`adapter`, `terminal_write`, `native_acceptance`, or `revoked`.

If no physical write started, the request may remain available for another
attempt. If input may have reached the CLI without confirmed acceptance, Elwood
closes the API request once as `unavailable` and removes it from `listQuestions()`.
Its old ID then rejects with `question_not_found` before writing. Refresh the list
and terminal view; offer an answer form only for a currently available request.

Elwood keeps the uncertain native identity reserved, holding ordinary input until
native closure, turn end or shutdown. A redraw, changed metadata for the same
identity or a late write completion cannot restore the answer form. A later
native acknowledgement releases that reservation without a second closure event.
An unavailable API request does not mean the CLI is ready; the terminal remains
available for manual inspection and recovery.

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
hooks must match the native Claude tool-use ID (`tool_use_id`), or the ordered
question definitions when the hook omits that ID. Unrelated Claude hooks cannot
acknowledge the request.

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
[CLI behavior](cli-behavior.md#native-interactive-question-records-2026-10-20) for evidence.

Codex question automation is bounded to 256 pending native requests and 1 MiB
of candidate metadata; each call is limited to 256 definitions and 1 MiB of
input metadata. Replay protection retains at most 4,096 retired identities and
1 MiB of key data. Overflow closes exposed requests as `unavailable` and disables
question automation until a new session is created. Ordinary text, slash-command,
loop and login writes remain held until native turn-end evidence. Raw `sendKeys()`
remains available for manual input and recovery. Unanswered requests have no
invented expiry deadline.

Codex normalizes CRLF and CR to LF and trims Rust Unicode White_Space from the
ends of submitted text (U+FEFF is retained). Interior whitespace is preserved.
Modal option labels remain exact; optional notes use the text normalization.
Elwood checks that long, clipped and multiline text, including text matching an
editor placeholder, remains in the same question editor. The call resolves only
after the complete accepted text matches the normalized submitted answer.
Budget disablement emits one content-free `question_automation_disabled` warning
and its normalized warning activity. Raw human terminal input remains available.

A successful Claude final submission waits for matching native completion even
after an empty composer appears. An interrupted, unconfirmed answer closes its
API request as unavailable while retaining the native identity and input hold
until native closure.

Aborting the call does not undo an answer already submitted to Claude.
