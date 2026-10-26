# Hard-Won CLI Behavior Notes

Elwood drives the real Claude and Codex CLIs through a PTY. Those CLIs have
undocumented, version-coupled behaviors that repeatedly cost debugging time —
and that a green unit suite at 100% coverage does **not** catch, because they
only surface against the real CLI. This file records what we learned empirically
so the next engineer or agent does not rediscover it the hard way.

## Upstream references

Elwood no longer vendors copies of the agent CLIs' documentation. The official
sources are:

- Claude Code: https://code.claude.com/docs/
- Codex CLI: https://developers.openai.com/codex/ (short sourced notes in
  `docs/codex/`)

Each fact below was verified against a real CLI (versions noted where relevant).
When a fact drives an implementation decision, the code and the matching PRD
conformance criterion are cited. If you change behavior here, update `prd/`
first (see `CLAUDE.md` / `AGENTS.md`), then this file.

## Approval policy compatibility

Codex 0.155.1 rejects `--ask-for-approval untrusted`; its accepted values are
`on-request` and `never`. Real approval-flow tests on this version use `on-request`
with a read-only sandbox and a tool that needs to write, then approve the native
escalation dialog. An `untrusted` fixture exits before readiness and cannot test
working-dialog clearance. Verified from the installed CLI's argument error on
2026-09-19 while exercising C-ATTN-02.

## Readiness

**Codex 0.159.2 adds a warning counter to its shortcuts footer.** A bounded
invalid-model cold-start probe on 2026-10-01 captured `? for shortcuts` followed
on the same row by `⚠ 3 warnings · f2 to view`, below the model footer and empty
`› Ask Codex to do anything` composer. Its animated welcome said “Follow the
white cursor.” The existing footer grammar rejects this captured row. The trace separately
showed a retained trust episode and a held 10-second readiness deadline; it did
not capture each observed frame, so it cannot attribute the original gate or
prove that this final snapshot was the frame at that deadline. No submission Enter or UserPromptSubmit occurred,
so the probe establishes startup layout/readiness evidence, not hook/transcript
ordering. Clearance accepts the bounded native warning-count suffix while still
requiring current settled frame, visible input cursor, native model chrome, and
absence of active dialogs or work. A follow-up probe with this grammar recorded
folder trust followed by the warning-bearing composer: the trust hold cleared,
and both cold and resumed sessions reached ready and delivered exactly one
invalid-model submission with one `UserPromptSubmit` each. No valid model was
used. C-API-28, C-TRUST-01.

**Codex fires its `SessionStart` hook lazily — on the first turn, not at boot.**
Any experiment that waits for a boot-time Codex hook *without running a turn* is
invalid and will conclude the hook "never fires". (This once produced a false
"CODEX_HOME disables hooks" claim, since retracted — Codex hooks work fine under
sandboxed homes, and user `config.toml` hooks merge additively with `-c` hooks.)
Because `SessionStart` is Elwood's authoritative Codex readiness signal
(`markInitialReadyFromHook`, `src/codex/session/hooks.ts`), cold-start readiness
comes from that hook, bounded by a **two-stage starvation deadline** armed on the
first render frame (`src/runtime/readiness/initial-ready.ts`): after 10 s
(`initialDeadlineMs`) Codex readiness waits for a configured composer, described
below, and after 60 s (`initialBackstopMs`) it is released without one. C-API-28.

**Codex 0.164 paints a boot composer before its session is configured
(2026-10-25).** About 0.6 s after its first output Codex draws `› Ask Codex to do
anything` and `? for shortcuts` with no model footer; the header may read
`loading` or already show the path. The model footer (`GPT-6.1-Sol default ·
<path>`) appears only once the session is configured, which for an untrusted
folder is after the directory-trust gate is answered. On a loaded machine (load
average 20 to 127, 8 concurrent launches with `autotrust`, fresh `git init`
folders) the gate painted 11.1 to 30.6 s after the first output in 24 of 32
launches, and every one of those 24 reported `ready` at 10.0 s, onto a screen
showing the boot composer without a footer. The other 8 painted their gate at
8.9 to 9.0 s and readied after it, on footed composers. Unloaded, the gate came
3.4 to 3.9 s after the first output. Codex's deadline therefore marks only onto a
composer with its model footer (`codexComposerConfigured`,
`src/codex/screen/clearance.ts`), and a 60 s backstop, twice the longest measured
gate delay, releases readiness if no footer is ever recognized; a gate painting
later than that would still follow `ready`. Fixtures:
`tests/fixtures/codex-0.164.0/boot/`. C-API-28.

**Codex 0.153.3 can still swallow the deadline-released first paste under load.**
Its cold composer may accept the paste visually, repaint another startup spinner,
clear the prompt without firing `SessionStart` or `UserPromptSubmit`, and then
return to the idle composer. That produces the same rendered `running → ready`
shape as a completed empty turn. Do not solve this with a longer arbitrary
deadline or raw-screen output. The ergonomic turn owner requires positive
acceptance (`UserPromptSubmit`, turn content, or `Stop`) before consuming the
idle edge; after the normal quiet window it replays the same submission at the
now-live composer at most twice, then raises `wait_timeout`. Verified by the
compiled CLI smoke against Codex 0.153.3. C-API-48.

**Claude re-fires `InstructionsLoaded`/`SessionStart` on resume; Codex does
not.** So a resumed Claude session reaches ready fast via its hook, while a
resumed Codex session would otherwise wait out the full 10 s deadline (the
conversation already exists, so no `SessionStart` re-fires). To avoid that, on
**resume only**, Elwood also accepts the rendered composer as a readiness signal
(`createReadinessGate(onReady, resumed)`, `src/runtime/session/readiness.ts`).

**The composer marker is safe as a readiness signal on resume, but NOT on cold
start.** On a cold start the composer (`›` for Codex, `❯` for Claude) is a
**boot-time placeholder** that paints ~1 s before the input loop is live and is
byte-identical to the ready composer — sending a prompt then gets silently
swallowed. On resume the conversation already exists, so the composer is live
when it paints and a prompt sent at that moment is accepted. This is why the
resume-composer path is gated on `resumed`. C-API-28, PRD §5.3.

**The composer caret is byte-identical to a permission/trust dialog's option
caret.** A resume opening onto a dialog must NOT latch ready off the composer, or
a draining Enter could approve the dialog. Resume-composer readiness is gated on
`!facts.blocking_prompt_visible`. This is a security property, not a nicety.

**Observe readiness through the signals Elwood sends — never the state file.**
`session.status`, the `status` event, or `waitForStatus(s => s === "ready")` on
the live session object. The persisted `session.json` holds ONLY core resume
metadata (adapter, cwd, per-adapter resumeId + launch posture). A separate loop
sidecar may hold explicitly requested recurring definitions and wall-clock
creation/expiry values, but it carries **no live readiness, due, or timer
state**, so neither file can be polled for readiness.
Status lives in memory only, on the live session. `statusDecisions()` is likewise
**live-only, per-instance, never persisted** — on resume it is empty at t=0, so
`statusDecisions().some(d => d.to === "ready")` is not a valid "has this
conversation ever been ready" derivation. (Both mistakes were real consumer bugs
misattributed to a CLI regression.)

## Resume lifecycle

- `resumeCodex`/`resumeClaude` use the same start path and build a **fresh**
  `SessionStatusEngine` (`current: "starting"`, empty decision log). `session.status`
  reads that fresh engine, not the persisted record.
- At t=0 when `resume()` resolves, both adapters report `status: "running"` with
  `decisions: [startup_usable → running]` (the ~500 ms startup-usable check fires
  before the promise resolves), then reach ready via `initial_ready → ready`.
- **Resume replays the transcript on screen, and those replayed footers read as
  `working_visible`.** Left unhandled this fabricates a phantom `running → ready`
  turn on every resume (a consumer-visible "false unread"). The turn watcher arms
  in a **settling** mode on resume that suppresses rendered turn edges until the
  composer stays quiet and non-blocking for a *sustained run of consecutive
  frames* — the replay repaints in bursts with brief quiet gaps, so a single
  quiet frame is not proof it finished. Evidence-driven turns (a caller
  submission, a hook) bypass settling immediately. `src/core/turn-state.ts`,
  C-TURN-03.
- **Codex 0.164.0 paints a `Resuming session…` placeholder before it loads the
  conversation (2026-10-25).** Five captured resumes in private Codex homes, at load
  averages of 20 to 60, all had the same shape. First comes the header, then
  `Resuming session…`, then the live composer and `? for shortcuts`. That frame
  repaints 8 to 11 times with no visible change. Elwood latches resume readiness on
  its first composer frame. 0.5 to 1.6 s later, Codex sets a braille title spinner
  and `OSC 7501;state=working:app=codex`. It replaces the placeholder with the
  replayed transcript, either in the spinner's first frame or one frame later. The
  spinner runs 0.7 to 1.5 s. Then the title goes idle with `state=idle`, at most one
  cursor repaint follows, and Codex sends nothing more until input arrives. The quiet streak counted the
  placeholder's repaints and released settling before the load. The spinner then
  became a phantom `running → ready` on every capture. The real-CLI e2e reported it
  as `saw: running,ready`. Placeholder frames are no longer quiet. Once the
  placeholder has painted and the load's spinner has been seen, the first quiet
  composer ends settling. A five-frame streak never arrives from an idle Codex.
  Captures: `tests/fixtures/codex-0.164.0/resume/`. C-TURN-03.
- **Codex records a turn's completion only after its `Stop` hook returns
  (2026-10-25).** Elwood reports `ready` from that hook, so a host that stops the
  session at that `ready` signals Codex 0.164.0 before it writes the turn's
  `task_complete`, and Codex exits without it. Stopping in the `ready` listener lost
  the record in 3 of 3 probe runs and in 2 of 2 runs of
  `tests/e2e/codex-stop-commit.e2e.ts` on `main`. Stopping 66 ms later lost it too;
  at 156 ms and at 1 s it was written. The record carries the hook's `turn_id`, and
  its own timestamp falls 3 to 94 ms after the hook reached Elwood. Resuming such a
  conversation replays it ending in
  `■ Conversation interrupted - use /feedback if something went wrong`. Before the
  placeholder fix, that banner closed the spinner's phantom turn early and a second
  phantom followed: `saw: running,ready,running,ready`. The `uncommitted-turn`
  capture retains that replay. `stop()` and `teardown()` now give Codex up to 2 s to
  write the record before signaling it. With the wait, a stop at `ready` took 70 to 126 ms
  instead of 13 to 29 ms, and the record was always written.
  `src/codex/session/turn-commit.ts`, C-TURN-03, C-LIFE-13.
- **A caller submission can precede the resumed composer's repaint.** The old
  idle composer may remain visible briefly after `caller_submitted`; that frame
  is not a turn end. Resume settling now synchronizes to current rendered work
  and waits until a working frame has established the real turn (an interrupt
  completion banner remains a valid immediate end). This fixed empty resumed
  Claude responses observed through the compiled headless command. C-TURN-03.
- **Claude ≥ 2.1.201 skips conversation persistence for NESTED instances** (when
  `CLAUDECODE` / `CLAUDE_CODE_*` are in the environment) → resume finds nothing.
  The e2e helpers strip these vars (`tests/e2e/helpers.ts`); real terminals are
  unaffected.

## Turn boundaries (rendered TUI)

- **Claude 2.1.281 can use `◐ Claude Code` as its OSC working title.** A native
  173×35 capture on 2026-09-23 showed `✻ Wandering… (0s)` above a fenced empty
  composer, with a visible cursor at column 2, row 15 (zero-based), and no
  `esc to interrupt` footer. The preceding frame showed a running
  `UserPromptSubmit` hook with the same title. The session later reached a usage
  limit; this capture proves working-title geometry, not a successful answer.
  `tests/fixtures/claude-2.1.281/working.txt` retains the nonempty captured rows
  with the temporary directory normalized. The title matcher accepts the
  observed `◐ ` prefix alongside the existing braille range; both screen facts
  and live trust clearance share it. No other new spinner glyph is inferred.
  C-TURN-05, C-TRUST-01.
- **Claude 2.1.310 alternates its working title between `◐` and `◑`, and its
  spinner row has no `esc to interrupt`.** Sampling the title every 50 ms through
  real turns (2026-10-25, Opus 5.5, 189 columns) gave `✳ ◐ ◑ ◐ ✳` and
  `✳ ◐ ◑ ◐ ◑ ◐ ✳`, each half circle lasting about a second, with `✳` while idle.
  The spinner row reads `✢ Nebulizing… (2s)`, or
  `✶ Computing… (running Stop hook · 8s · ↓ 3 tokens)`, and no frame of those turns
  contained `esc to interrupt`, so the title was the only working signal. With only
  `◐` recognized, every `◑` frame read as idle: the session reported
  `running → ready → running` about once a second for the whole turn, eight false
  `ready`s during one 6 s `sleep` tool call. The ergonomic turn treats an accepted
  `ready` as the start of its 2 s quiet window, so a turn with more than 2 s between
  a `◑` frame and its first text settled early. Six concurrent `send("Reply with
  exactly OK…")` calls returned `""` in 5 of 6 at load 117 and 6 of 6 at load 207,
  with Claude's `Stop` carrying `OK` 2–4 s later. Both half circles now read as
  working (`tests/fixtures/claude-2.1.310/working-half-right.txt`): the same six
  sends returned `OK` 6 of 6 at load 120–126 with no `ready` before `Stop`.
  C-TURN-05, C-API-48.
- Both CLIs render the literal `esc to interrupt` only while a turn is running
  (Claude footer, Codex "Working" spinner). Elwood's `TurnStateWatcher` keys off
  this, and **arms only after initial readiness** because the Codex MCP boot
  spinner borrows the same wording and would otherwise fabricate a turn.
- **Escape interrupts fire ZERO hooks on both CLIs** — the rendered TUI is the
  only interrupt signal. (Claude occasionally fires a `Stop` near a block
  boundary; it is timing-dependent, so do not assert either way in e2e.)
- **Narrow terminals elide the footer.** Claude drops `esc to interrupt` below
  ~66 cols (truncation with ellipsis, not wrap); at ~46 cols no screen text marks
  "working" at all. Turn *end* is therefore also detected from interrupt banner
  regexes (`⎿ Interrupted` for Claude, case-sensitive; `Conversation
  interrupted` for Codex) which fire at any width. C-TURN-01..05.
- On a narrow screen the working spinner may hide while streaming and persist
  after done — do not treat spinner presence as a reliable per-frame liveness bit
  at tiny sizes.

## Rejected turns (2026-10-25)

**Claude 2.1.310 ends a rejected turn with `StopFailure`, never `Stop`.** A bogus
`--model elwood-bogus-model` is refused before any model quota is consumed. The
hooks were `InstructionsLoaded`, `SessionStart` (`model: "elwood-bogus-model"`),
`UserPromptSubmit`, then `StopFailure` with `error: "model_not_found"`, a
`prompt_id` matching the submit, and `last_assistant_message` set to Claude's own
"There's an issue with the selected model (elwood-bogus-model)…" text. No `Stop`
fired. The transcript writes that same text as an `assistant` entry carrying
`isApiErrorMessage: true`, `error: "model_not_found"` and `message.model:
"<synthetic>"`, so Elwood's transcript activity surfaces it as an ordinary
`assistant_message`. Startup also shows `⚠ Model "elwood-bogus-model" isn't
recognized`, so the session reaches ready normally. Before C-API-59 the
no-oracle quiet window settled that turn as a success: `ClaudeSession.send`
resolved with the error text and `elwood run` exited 0 with it as `response`.
Elwood now reads `StopFailure` as rejection evidence (`claudeBoundarySignal`) and
fails the turn with `turn_failed`, message `Claude rejected the turn:
model_not_found`. The assistant text is not the diagnostic (§6.1). C-API-59,
C-CLI-28, C-E2E-20.

**The hook can lag the first rendered `ready` under load.** On an idle machine
`StopFailure` arrived in the same 0.1 s as `ready` and 0.3 s before the transcript
entry. With four concurrent sessions at load ~55, it lagged the first `ready` by
0.8, 2.0, 2.5 and 1.8 s. One run rendered a transient `ready → running → ready`
before the hook. The turn fails only if the hook arrives before the turn settles,
and a no-oracle turn settles 2 s after its last content. That is the same lag
that can end a successful turn early when its `Stop` is late. A hook that late can
also land while the NEXT turn is running. Each hook is delivered by its own bridge
process, so the next turn's `UserPromptSubmit` can even arrive first. Elwood
therefore applies a `StopFailure` only after the turn's own `UserPromptSubmit`, and
only when its `prompt_id` matches that submit's.

**Codex 0.164.0 rejects the same bogus model without any boundary hook.** In a
sandboxed `CODEX_HOME`, only `SessionStart` and `UserPromptSubmit` fired. The
evidence is a transcript `event_msg` `task_complete` carrying `error`, with
`last_agent_message: null`, as first measured on 0.155.0. The record's `turn_id`
(and `root_turn_id`) equal the `UserPromptSubmit` `turn_id`. `error.message` is the
service's raw JSON body (`{"type":"error","status":400,"error":{...,"code":
"model_not_found"}}`, "…model is not supported when using Codex with a ChatGPT
account."), and `error.codex_error_info` is `"other"`. The binary's
`CodexErrorInfo` kinds are bare strings (`usage_limit_exceeded`, `bad_request`,
`other`, …) or one-key objects for kinds with fields (`http_connection_failed`,
`response_stream_connection_failed`, `response_stream_disconnected`, …). The
screen still reached `ready` 1.4 s after the submit hook and 0.15 s before the record.

On 0.164.0 the turn binds the submit's `turn_id`, and only a private `Stop` or a
classified rendered completion ends it. A rejected turn has no `Stop`, so its end
depended on the rendered path. In the A/B runs (load 60–100), `CodexSession.send`
resolved `""` about 20 s after submission, and `elwood run` exited 0 with
`"response": ""`, the same empty success 0.155.0 showed. In one earlier probe, run
beside a full test suite at load ~100, `send` stayed pending for over five minutes
and resolved `""` only when the CLI was killed. Elwood now
reads a failed `task_complete` that names the accepted `turn_id` as that turn's
native boundary (`confirmCodexRejection`) and fails it with `turn_failed`. The
message is `error.message` and `details.agentError` is the `codex_error_info`
kind. A second turn on the same session is rejected the same way, so the first
released the session at its real boundary. C-API-60, C-CLI-28, C-E2E-21.

## Codex transcript replies

**Codex 0.149.1 writes committed replies as phased `message` response items, not
`agent_message` items.** The assistant's commentary and final reply are separate
`response_item` records whose payloads use `type: "message"` and a `content[]`
array of `{ type: "output_text", text }` entries. Only the assistant record with
`phase: "final_answer"` is the committed room reply; `phase: "commentary"` is
progress narration, and user/developer message records are inputs. Current
sessions emit no legacy `agent_message` duplicate, so treating `content` as a
plain string silently drops the reply text. The transcript adapter therefore
extracts assistant `final_answer` records as `assistant_message` and
`commentary` records as `assistant_progress`, while retaining legacy
string/final `agent_message` support. Explicit non-final legacy mirrors keep
only their raw observation. C-CODEX-16, C-CODEX-22.

## Model selection persistence

- **A configured legacy Codex model may be absent from `/model`.** On Codex
  0.154.0, `gpt-5.1-codex` still appeared in the session header but not in the
  visible catalog; every returned row correctly had `isCurrent: false`.
  Real picker tests should let the installed CLI choose its launch default,
  rather than pinning a model that can disappear from the catalog.
- **Codex 0.164.0 marks only the `(current)` row; nothing on screen names the
  default.** Probed 2026-10-25 in a sandboxed `CODEX_HOME` whose config sets
  `model = "gpt-6.1-sol"`, with the session launched on `--model gpt-6-luna`: the
  picker drew `› 4. GPT-6-Luna (current)` and no marker on GPT-6.1-Sol. A session
  switch moves `(current)` to the new row, again with nothing on the launch model.
  Older Codex drew `1. gpt-5.5 (default)` beside `2. gpt-5.4 (current)`
  (`codexPickerSplitMarkers`), so reading "a lone `(current)` row is also the
  default" reported the session's own model as the user's default. Elwood now reads
  the default from `config.toml`. The cached catalog (`models_cache.json`) carries
  no default flag, so Codex's built-in default in an unconfigured home cannot be
  identified at all.
- **Claude scrolls a list longer than ten rows inside the picker (2.1.310, 2026-10-24).**
  An account with 13 models renders a ten-row window. At the top, rows 1–9 are plain,
  row 10 is `↓ 10. Opus 4.8 …`, and `… +3 models` stands directly under it. Moving the
  cursor past the last visible row scrolls the window by one: the first visible row then
  carries `↑` (`↑ 2.`), and the last carries `↓` with `… +2 models` / `… +1 model` below it
  while any rows stay hidden; at the end of the list that line is blank. The cursor glyph
  REPLACES a marker on its row (`❯ 11. Opus 4.7` above `… +2 models`), and moving up keeps
  one row visible above the cursor, so arrowing from row 5 to row 4 shifts the window from
  `↑ 4.`–`13.` to `↑ 3.`–`↓ 12.`. The picker OPENS scrolled when the current model is below
  the fold: started on `claude-opus-4-6`, it showed `↑ 3.` through `❯ 12. Opus 4.6 ✔` and
  `… +1 model`, with the `Default (recommended)` row out of view. Two consequences: the
  region grammar must accept a block that starts at its `↑` row and ends at its `↓` row or
  overflow line (before this, it rejected every frame of such a list, so `setModel` failed
  on its first arrow key with "The model picker was replaced"), and `setModel` must settle
  on the cursor row's identity, not its index, because a target's index changes as the
  window scrolls under the cursor. Fixtures:
  `tests/fixtures/claude-2.1.310/model-picker/`. C-API-23, C-API-24.
- **Arrow keys walk Claude's picker window without applying anything (2.1.310, 2026-10-25).**
  Row numbers are absolute positions, so a window starting past row 1 hides the rows
  above it and `… +K models` counts the rows below; `listModels` reads the whole list by
  walking the cursor one row at a time and merging the windows by number. Measured on a
  13-model account: the window scrolls DOWN only once the cursor passes its last row, keeping
  the cursor ON the last visible row (`↑ 2.` … `❯ 11.`), but scrolls UP while one row is
  still above the cursor (`↑ 3.` `❯ 4.`), so the cursor never sits on the first row of a
  scrolled window. Both ends WRAP: `↓` on row 13 jumps to `❯ 1.` with the top window, and
  `↑` on row 1 jumps to `❯ 13.` with `↑ 4.`–`13.`; Elwood never presses past an end. Opened
  at the top, 12 `↓` reveal rows 11–13; opened scrolled on row 12, one `↓` and 11 `↑`
  reveal rows 13, 2, and 1. After 28 arrow presses, Escape printed `⎿ Kept model as Opus
  5.5 (default)`, the header kept `with xhigh effort`, and the reopened picker showed the
  same current row and effort, even though the effort row had followed the highlight
  (`◐`, `●`, `○ Effort not supported`) on the way. A session started with `--name` adds a
  rule carrying the name above the picker and walks identically. Fixtures:
  `walk-down-from-top.txt`, `walk-opened-scrolled.txt` (frames separated by `--- ↓`/`--- ↑`,
  each the screen after that key). A move that scrolls the window can be read before its
  overflow line is repainted: a real listing that read on every render (2026-10-25) read
  the move to `❯ 11.` with a `… +K models` count that was missing or did not add up to 13,
  so the walk waits for a frame whose count adds up instead of failing on that one.
  The raw stream shows why: the renderer writes only the cells that change, top to bottom,
  and the PTY delivers the paint in reads of about 1 KB, so a frame can be read between
  two reads. Scrolling to row 11 arrived as a 1,020-byte read carrying the new rows and a
  71-byte read carrying the `3`→`2` of the count. The opening paint is ordered the same way:
  the `… +K models` line is written before the effort row and the footer, and Elwood reads
  the picker as complete only once its `Esc to cancel` footer is on screen, so a complete
  frame always carries its count. Replaying every byte prefix of two real listings (opened
  on row 2 and walked to 13; opened on row 10, where a count-less frame would read as a
  complete ten-row list) found no complete frame stating fewer than 13 rows; the only
  inconsistent ones were the stale-count frames above (`claude-picker-paint-order.test.ts`
  pins the row-10 opening, `opening-on-row-10.json`, captured paint bytes over a placeholder
  screen). If a later Claude painted the footer before the count, the walk could take a
  full window with the cursor on its last row for the whole list: a listing would come back
  short, and `setModel` would reject a hidden id as unknown. No key would go anywhere else,
  since every key is still gated on the operation's own complete picker. C-API-23, C-API-24.
- **The picker's effort row follows the HIGHLIGHTED model, and `●` is one of its glyphs.**
  On 2.1.310 the row under the list reads `○ Low effort`, `◐ Medium effort`, `● High
  effort`, `◉ xHigh effort`, or `◈ Max effort` (each `←/→ to adjust`, with `(default)` when
  it is that model's default), and `○ Effort not supported for Haiku 4.5` for a model
  without effort. It changes as the cursor moves, so navigation crosses several glyphs.
  `●` is also the older Claude reply bullet, which the region grammar treats as foreign
  content, so the control row is recognized by its own copy before the reply check;
  otherwise every frame with the cursor on a High-effort model reads as transcript. Captured
  with `--effort low|medium|high|max` across all 13 rows. C-API-24.
- **Claude paints `/model` over its slash-command menu, so the header lands first.** A
  5 ms capture on 2.1.310 (2026-10-24) showed the `Select model` header for 10–500 ms above
  a partial dialog: rows 1–3 with row 3 spliced into a stale `/review-…` suggestion and
  the rest of the menu below it, rows 1–7 the same way, or all ten rows and the overflow
  line above leftover menu prose and no footer yet. Parsing the first frame that showed
  the header returned one row, three rows, or none (`listClaudeModels` in `~/.coal-harbor`
  gave 9, 1, error, 9, error over five runs), and Coal Harbor persisted a one-row
  `default` catalog as a successful discovery. The picker is therefore parsed only once
  the region grammar recognizes the complete dialog, footer included — the same check
  every key write passes. A picker that never completes is never written to, because a
  bare header is untrusted (the agent can print one): the operation fails, and failure
  cleanup Escapes the dialog once it is recognizable. Cleanup's release is not proof the
  picker is gone either: a blank or half-painted frame matches neither grammar, and the
  picker can paint again after it. So once the operation or its cleanup has seen its
  dialog, or while the picker header is up, a cleanup that ends on anything short of a
  positively clear composer keeps queued input held until the composer is clear: Enter on
  that picker would apply its highlighted row. Only a dialog the caller owns replacing it,
  a complete `PreModelSwitch` hook confirmation, ends that hold early; the hook's prompt is
  left for the caller. The header only ever holds; it never authorizes a key. Fixtures: `tests/fixtures/claude-2.1.310/model-picker/painting-*`.
  C-API-23, C-API-24, C-API-55.
- **Claude can list a compiled five-row picker instead of the served catalog (2.1.310,
  2026-10-25).** Observed: launched with `CLAUDE_CODE_MODEL_CATALOG=0`, the picker lists
  `1. Default (recommended)`, `2. Opus`, `3. Fable`, `4. Sonnet`, and `5. Haiku`. Those are
  bare family names with no version, and there is no overflow line. Every listing in that
  process returns the same five rows, and Elwood reads them correctly. A listing e2e on a
  loaded machine got the same five rows for its whole session, with no catalog variable in
  its environment (the e2e harness strips `CLAUDE_CODE_*`).

  From the 2.1.310 bundle, not observed: the choice is made once per process. The catalog
  is off when `CLAUDE_CODE_MODEL_CATALOG` is falsy, under `--bare`, with nonessential
  traffic disabled, with `ANTHROPIC_UNIX_SOCKET` set, with a provider that is not
  first-party, with auth that has no catalog scope, when policy disallows
  `allow_model_catalog`, or when the `tengu_delegated_quail` flag is off. With no catalog
  cached in `~/.claude/cache/model-catalog/`, a first fetch slower than 1,750 ms (1,500
  headless) also falls back.

  The fallback has no hidden rows, so the listing e2e can't test the window walk against
  it. Instead of retrying, the e2e fails with these causes
  (`tests/e2e/claude-compiled-fallback.ts`), so a degraded environment stays visible.
  C-API-23.
- **Codex 0.164.0 shortened its dialog hints.** The picker closes with `enter select ·
  esc back` and the reasoning screen with `enter default · s session · esc back` (one
  Escape still returns to the picker). Neither matched the old closing-hint phrases
  (`esc to cancel`, `esc to go back`), so the grammar never recognized either dialog:
  `setModel` failed on its first key with "The model picker was replaced", and only the
  header-parsing `listModels` kept working. Each CLI now supplies its own hint phrase,
  so Claude's `Esc to cancel` no longer closes a Codex dialog either. The new `s session`
  key is a session-only apply. Fixtures: `tests/fixtures/codex-0.164.0/model-picker/`.
  C-API-23, C-API-24.
- **A model dialog replaces the composer; nothing renders below it.** Full-viewport
  captures from Claude 2.1.274 and Codex 0.154.0 (2026-09-17,
  `tests/helpers/model-dialog-viewports.ts`) show the picker, Codex's reasoning
  level, and Claude's cache warning each ending the viewport, while the closed
  state puts the composer back (`❯` between rules; `› Ask Codex to do anything`).
  Rows ABOVE the dialog are ordinary transcript: Claude keeps `❯ /model` and reply
  rows (`⏺` on 2.1.274, `●` earlier) there, so provenance is "no conversation or
  composer row BELOW the header", never "none above". Picker text quoted in a reply
  always has the working row and composer beneath it, so it is not a live dialog
  and must never receive an Escape, which would interrupt the running turn. Claude
  2.1.274's picker also carries an effort row (`◉ xHigh effort ←/→ to adjust`)
  between its rows and footer. A closed Claude picker leaves only `❯ /model` /
  `⎿ Kept model as …` behind, no header. Two more things are never a dialog: the
  phrase on a reply or composer row itself (`❯ Select model` is staged input), and
  a quoted picker above another dialog. Below its header a native dialog holds
  exactly one contiguous block of picker rows (description column, numbered from 1,
  at most one cursor); the one exception is a scrolled Claude window, which starts at
  its `↑`-marked row (see the windowed list below). Any other caret or numbered row
  (`❯ 1. Yes`, `  1. Yes`, a staged `❯ 1. fix this  then that`) restarts the
  numbering, follows the blank or rule that separates the composer, or lacks the
  column, and marks the region as someone else's. The block must also be COMPLETE
  before Elwood treats it as live: every captured picker and reasoning screen carries
  at least two numbered rows and a closing hint row (`Esc to cancel`, `esc to go
  back`, `esc back`). A header with neither —
  a transcript quoting `Select model` above a trust or hook prompt, or above a
  reply's own numbered list — is a fragment, and Escaping it would dismiss the live
  prompt underneath. The CURSOR is deliberately not required: a complete picker
  still painting its cursor is live and must keep holding input, and `setPickerModel`
  rejects the missing cursor on its own.
- **A live switch dialog is never hung directly off an agent reply row.** The warning
  screen carries no closing hint row, so completeness cannot be judged the way the
  picker's is. Indentation cannot judge it either — the title itself may sit at column
  zero, so a column test passes a staged draft straight through. Nor can option ORDER:
  `Yes` normally precedes `No`, but a real reordered layout exists where the cursor starts
  on `No` above `Yes` (`claudeModelCacheConfirmationYesBelow`), so an affirmative-first
  rule rejects a live dialog. What does hold is the separator: Claude replaces the composer
  with the dialog, so a live one is preceded by its rule (or the blank line before it),
  never by an agent reply bullet. `parseClaudeSwitchConfirmation` therefore rejects a title
  sitting DIRECTLY under a reply row, and reads options only from the dialog's own
  contiguous run of action rows, so a staged `❯ Yes, switch to Fable` below a quoted
  warning cannot pair with a quoted `No, go back`. C-API-24, C-ATTN-04.
- **A picker's closing hint row TERMINATES its region.** Only blank lines and rules may
  follow it. Otherwise a transcript quoting a complete picker — footer and all — above a
  live trust or hook prompt still reads as a live picker, and Escaping it would dismiss
  the human's prompt instead. For the same reason the header must be prose: a numbered
  composer draft (`❯ 1. Select model  draft` / `2. next  text` / `Esc to cancel`)
  otherwise satisfies the row and footer grammar entirely on its own. C-API-24.
- **A picker mid-repaint is briefly unrecognizable, so one clear frame proves nothing.**
  This is the same shape as the resume-replay settling above, and the picker hold reuses
  that measured value (5 frames) rather than inventing a smaller one: the replay's quiet
  gaps were measured at one frame and 5 clears them with margin, while the picker's gap
  length is NOT measured. The failure directions are asymmetric — too high delays
  releasing the input hold, too low releases queued input into a repainting dialog where
  Enter applies the highlighted model — so the conservative measured precedent wins until
  someone captures real picker repaint frames. Cleanup uses a shorter streak on purpose
  because it is bounded at one second and must send its Escapes inside that budget; it
  hands off to the survivor hold, which applies the full streak, so nothing is released
  early. `src/runtime/session/picker-cleanup.ts`, C-API-55.
- **Escape on a follow-up stage returns to the picker, not the composer.** On both
  Claude 2.1.274 (cache warning) and Codex 0.154.0 (reasoning level) one Escape
  reopens `Select model` / `Select Model and Effort`; a second closes it. Failure
  cleanup therefore sends one Escape per stage and never repeats one: a second
  Escape during a slow repaint would land on the composer. C-API-55.
- **Claude paints its cache warning over the picker, with one partial frame.** A
  5 ms frame capture on Claude 2.1.274 (2026-09-17) shows no idle composer between
  the `s` key and the warning: 28 ms after the key one frame has `Switch model?`
  and the cache copy above STALE picker rows (`❯ 1. Fable …`), with neither
  `Select model` nor the Yes/No options; 7 ms later the dialog is complete
  (numbered, cursor on `1. Yes, switch to …`). In that frame the title-only shell
  cannot be told from a `PreModelSwitch` hook confirmation, so Elwood holds input on
  it and never writes to it, and `setModel` does not treat a caret-only row
  elsewhere in the viewport (a reply quoting the prompt) as the returned composer
  while the shell is up. Before this, `setModel` resolved on that frame without
  ever confirming the switch. C-API-24, C-API-55.
- **Picker text visible before `/model` is submitted is not Elwood's.** A closed
  picker leaves no header behind, so `Select model` / `Select Model and Effort` /
  `Select Reasoning Level` text that precedes the command is a human's dialog or a
  transcript quote (which the unanchored open check would otherwise parse and
  drive). The operation rejects without writing. C-API-55.
- **Codex persists `/model` picker selections into the user `config.toml`.**
  `setModel` restores the prior default via compare-and-swap after switching
  (C-CODEX-14), skipping with a `codex_default_model_persisted` warning on a
  concurrent external edit.
- **Claude number keys in its picker instantly persist the user default** — never
  send them. Claude's `s` selection is session-only.
- **Claude 2.1.258 may interpose a cache warning after that `s` key.** The same
  component renders either `Switch model?` or `Change effort level?`, followed by
  the stable cache explanation that the next response re-reads full history and
  action rows `Yes, switch to …` / `No, go back`. The effort copy can disagree
  about the target (`Switching to high` while the action says `xhigh`), so do not
  compare target labels. Layouts may use `❯` or `›`, with or without option
  numbers. The switch has NOT applied when this dialog appears: select the
  affirmative from its rendered cursor, press Enter, and wait for the idle
  composer before resolving `setModel`. A `PreModelSwitch` hook can use the same
  dialog shell with its own confirmation reason; it remains blocking and MUST NOT
  be auto-accepted. Scope every title, copy, and option match to the bottom-most
  contiguous dialog and revalidate it before Enter: the transcript may itself
  quote an old warning (including a bare `❯`/`›` line), and whole-viewport matching
  can otherwise splice that stale text into a live hook dialog or mistake it for
  the returned composer. C-API-24, C-ATTN-04. Verified from the installed 2.1.258
  native binary and field-captured model/effort dialogs.

## Trust prompts

The real Claude folder-trust prompt renders as **one dialog** spanning header →
blank line(s) → descriptive prose → options, and the header question **wraps
across physical rows** on a narrow terminal. Its option format is version-coupled:

- Claude 2.1.206 used numbered rows with the affirmative first
  (`❯ 1. Yes, I trust this folder / 2. No, exit`).
- Claude 2.1.252 uses unnumbered cursor rows with the safe decline selected first
  (`❯ No, exit / Yes, I trust this folder`). Accepting requires moving the cursor
  to the affirmative and pressing Enter; sending the old numeric answer leaves the
  dialog waiting. From 2.1.310 evidence, never do that with a relative arrow and a
  separate Enter (see "Claude trust selection reset" below).

The workspace gate is independent of tool permission policy: it still appears
under both `--permission-mode bypassPermissions` and the exact
`--dangerously-skip-permissions` flag (verified against 2.1.252). A matcher MUST:

- match against the dialog's **joined** non-option lines, never line-by-line, and
  never treat a blank line as a dialog boundary;
- anchor on a non-option **header** line whose pattern matches the question
  wording — an option-only phrase (e.g. "trust this folder", which appears in the
  "Yes" option) must never anchor a prompt (anti-spoofing).
- treat the whole numbered or cursor-selectable block as the option region,
  including unselected rows above the cursor, then either send the old option
  number or select the affirmative by its absolute row and confirm in the same
  write.

Under `autotrust`, detect-and-approve: if a trust prompt is detected, answer yes
rather than leave the agent hanging on the gate. Keep the cheap safety: never
select a destructive-rider affirmative, and never answer a specific-affirmative
prompt (e.g. hook trust) with a generic "Yes". `src/core/trust/responder.ts`,
`src/core/trust/prompts.ts`, verified by `tests/e2e/trust-prompt-claude.e2e.ts`.

**Codex 0.156.1 uses a new folder-access dialog.** A native PTY capture on
2026-09-23 showed `Folder access`, the working directory, `Trust this folder?`,
the explanation beginning `Codex can read, edit, and run files here`, numbered
`Trust and continue` / `Quit` choices, and `enter continue · esc quit`. The question
and explanation share a row and wrap together. The previous grammar missed both
the question and footer, let startup report ready, and sent an image paste into
the unanswered dialog. Keep this layout as a separate exact-copy allowlist entry:
`autotrust` may select only `Trust and continue`; partial or changed copy must hold
input without approving it. The sanitized capture is
`tests/fixtures/codex-0.156.1/folder-access.txt`; parser and session regressions
cover both `autotrust` settings. A native rerun with this grammar answered the gate
and attached the first image; its later cancelled-draft cleanup failed separately,
so this is trust/attachment evidence, not a passing successor-cleanup run. C-TRUST-01.

**Codex 0.164.0 asked for folder trust only in a Git repository, and saved the answer to
`CODEX_HOME`.** Real launches on 2026-10-25, each with a fresh `CODEX_HOME`: in a plain
scratch directory, Codex reached `ready` and wrote no trust entry, with and without
`--sandbox read-only --ask-for-approval never` and with and without a seeded
`config.toml`; no trust gate rendered in the launches whose screens were captured. After
`git init` in the same kind of directory it showed `Folder access` with `Note: You’re in
a subdirectory of a Git project. Trusting will apply to the repository root:` and the
resolved path (`/private/var/...` for a `/var/...` cwd). `Trust and continue` then saved
`[projects."<that path>"]` with `trust_level = "trusted"` to `$CODEX_HOME/config.toml`.
Every launch also wrote `[tui] screen_reader_detection_done = true` there, plus state
and log databases, a models cache, and plugin and skill caches. An e2e that leaves
`CODEX_HOME` unset therefore writes into the developer's own `~/.codex`, so the suite
gives every process a private one (`tests/e2e/codex-home.ts`, C-E2E-22).

**Codex 0.164.0 draws its trust gates differently when hook trust is not bypassed
(2026-10-25).** Native launches at 100 × 40 in a `git init` scratch directory with a
fresh `CODEX_HOME`:

- With `--dangerously-bypass-hook-trust` or `-c hookTrust="trust-all"` (Elwood passes
  one of them on every launch, `src/codex/command.ts`), the `Folder access` gate is the
  0.156.1 layout: `1. Trust and continue`, `2. Quit`, and `enter continue · esc quit`.
  No hook gate follows.
- With neither, as C-E2E-09 launches Codex to see both gates, the same gate's decline
  reads `2. Back to Agent Command Center` and its footer is `enter continue · esc back`.
  After `Trust and continue`, `Hooks need review` follows with `1 hook is new or
  changed.`, `Hooks can run outside the sandbox after you trust them.`, `1. Review
  hooks`, `2. Trust all and continue`, `3. Continue without trusting (hooks won't
  run)`, and `enter confirm · esc skip`. Alternate screen or `--no-alt-screen` drew
  the same rows.

Without this grammar the unknown option and footers left both gates' option tails
invalid, so the responder held each gate and never answered it. The two footers are
bound to their gates (`TrustPromptSpec.footer`): each ends a dialog only under the
header, explanation, and options of the gate that draws it, and never counts as one of
the generic native footers that let an off-allowlist gate hold input. Under any other
dialog, or in conversation text, they make no frame a trust gate. The sanitized
captures, with the bypass and without, are `tests/fixtures/codex-0.164.0/trust/`.
C-CODEX-15.

### Where the clearance grammar lives

"This frame is the CLI's own idle composer, so the gate cleared" is a per-CLI layout
fact, and both CLIs change their chrome independently. It therefore lives with each
adapter's other verified screen facts — `claudeTrustClearance` in
`src/claude/screen-table.ts`, `codexTrustClearance` in `src/codex/screen-table.ts` —
and is injected into the shared coordinator (`TrustPromptResponder`/`trustView`).
When a CLI's banner, status row, or composer placeholder changes, update that adapter's
predicate. Codex's text grammar lives in `src/codex/screen/clearance.ts` and checks
known placeholders plus a native model footer or complete welcome box. Text-only
callers conservatively reject approval-like rows; the live session additionally
uses the actual visible input cursor to identify the composer, so transcript
caret/numbered rows above that input remain legitimate history. Dialogs hide the
cursor or leave it outside the composer. A bare caret never proves clearance.
Controlled post-settlement fixtures show that indented approval/trust headers or
cursor-option blocks can coexist with a stale visible composer cursor. Clearance
shares native trust-header classification without expanding C-ATTN-03 reporting.
The captured 0.156.1 `Folder access` prelude holds before copy/choices finish;
a selected numbered choice still holds after the prelude erases. Fresh composer
replacement clears the gate. These fragments veto staged recovery and empty ACK.
Assistant quotations require a native non-working assistant row and contiguous
indentation; blank/column-zero rows end them. Wrapped user history requires a
column-zero prompt, indented/blank continuation, then a non-working assistant
reply as its next column-zero row. Unknown rows and native numbered-choice blocks
cannot establish provenance. Bounded completed numbered user history remains
valid regardless of its number or label. Selected numbered rows outside that
completed history or an assistant quotation hold even without siblings. Generic
quoted menus and caret prompts retain live-cursor history treatment; unquoted option
blocks hold regardless of labels. Arbitrary identical dialog/transcript text is
not claimed distinguishable from one frame.
Native working rows and the live OSC working title retain the hold; prose that
merely quotes `esc to interrupt` is not a native working row. The title, cursor,
and text are read synchronously from the same completed render, including during
trust-attempt polling. Raw PTY receipt invalidates the proof before batching.
Both adapters now apply the same received/rendered boundary to human trust
clearance and every retry read. A render failure permanently invalidates that
terminal view; an unavailable view withholds automation within its existing
deadline. This guards bytes already received, not future output the CLI has yet
to send. A completed snapshot is reused until its render or viewport changes.
That includes an oversized receipt's staged tail: completion of its first 64-KiB
batch alone is not a complete render. The native working row includes elapsed
time before the interrupt hint (seconds, minutes/seconds, or hours/minutes/seconds),
as rendered by [Codex 0.142.5's status widget](https://github.com/openai/codex/blob/rust-v0.142.5/codex-rs/tui/src/status_indicator_widget.rs).
Parenthesized transcript prose without that native status grammar is not work.
An exact-shaped quotation such as `• Thinking (3s • esc to interrupt)` is ambiguous
and retains the hold. A real Codex 0.155.1 rejected-model probe showed a visible
column-two input cursor throughout native working frames; typing remains possible
while a turn runs. The title spinner is configurable, and status location varies
with preview rows, so neither missing title animation nor editable input disproves
that exact native status. We do not promise to distinguish identical transcript
and status rows from text/cursor evidence alone.
Real 0.142.5 and 0.155.1 trust/model dialog captures start DEC2026 before painting,
then hide the cursor with DEC25l before ending DEC2026. A 0.155.1 command approval
under `read-only`/`on-request` uses the same ordering: its selected Yes row ends
with the cursor hidden, not left visible on an old composer. Replaying all 1,078
character prefixes of that actual approval paint retains the hold; Escape restores
the visible composer afterward. The raw capture is preserved in
`tests/fixtures/codex-command-approval-render.ts`. These observations apply to the
captured versions and dialog types; a new CLI renderer needs new verification.
Those native partial frames cannot combine settled rendering with a stale visible
composer cursor. Captured protocol regressions replay the native bytes through trust clearance,
staged recovery, and empty-input guards. They establish the synchronized/hidden
cursor barriers, not an observed settled-visible partial dialog. Controlled
actual-session fixtures separately exercise that post-settlement policy.
The Claude predicate uses `src/core/trust/clearance.ts` for its separate grammar.
A real Claude 2.1.278 classic-renderer capture hides the cursor during trust and
restores it at column two on the composer only at the end of its idle paint.
Unlike the captured Codex renderer, that Claude paint has no DEC2026 envelope.
Splitting its bytes immediately before the final DEC25h leaves complete-looking
composer chrome while native cursor restoration is still pending. Live Claude
clearance therefore also verifies the visible native cursor on its composer row;
receipt settlement alone cannot identify that native paint boundary.
The same Claude 2.1.278 capture hides its cursor with DEC25l before repainting
its model menu. After that complete control, all 1,241 remaining character prefixes
retain the live hold, including prefixes where old composer chrome still passes the
text-only grammar. `tests/fixtures/claude-model-dialog-render.ts` preserves that
menu repaint without user paths or conversation content, and
`tests/unit/claude-model-dialog-render.test.ts` replays every prefix. This evidence
covers the captured model dialog; it does not establish behavior for arbitrary
replacement prompts or future Claude renderers.

Claude 2.1.278 can paint the complete folder-trust dialog before accepting keyboard
navigation. In the real human-trust test, immediate Down/Enter writes left the
selection on "No, exit". Waiting for the selected "Yes, I trust this folder" repaint
before Enter cleared the dialog. The 2.1.310 investigation below found the cause, an
input guard that remounts the dialog, and showed that waiting for the repaint is not
enough on a loaded machine. The test records physical PTY writes and confirms
that queued caller input follows native cursor clearance; it does not require a
model response or available turn quota.

`tests/e2e/codex-live-clearance.e2e.ts` also exercises production `startCodex`
with a fresh isolated configuration: queued input stays held at the human-owned
directory gate, then one benign prompt reaches `UserPromptSubmit` after manual
trust and visible native cursor clearance. Verified against installed Codex
0.155.1; the test cleans up the real session rather than waiting for model output.

A startup-only real PTY probe of Codex 0.142.5 on 2026-09-19 confirmed the
model-only `gpt-5.5 high` footer with `tui.status_line = ["model-with-reasoning"]`.
Its placeholder is randomized: observed `Use /skills to list available skills`,
`Find and fix a bug in @filename`, and `Implement {feature}` across launches.
The predicate recognizes the eight fixed placeholders in the version-tagged upstream
`chatwidget.rs` as well as the captured 0.154.0 default. It still requires native
footer or welcome-box evidence. The sanitized 100×30 capture and provenance are
in `tests/fixtures/codex-0.142.5/`; no model prompt was submitted.

### Native regions and live confirmation

Claude 2.1.252 places `Accessing workspace:` and the workspace path **before**
the trust question. The question may wrap; its explanatory copy is:

```
(Like your own code, a well-known open source project, or work from your team). If not,
take a moment to review what's in this folder first.
Claude Code'll be able to read, edit, and execute files here.
Security guide
```

The 2.1.206 capture omits `, or work from your team`. Blank rows and wrapping
remain part of one dialog. Unknown explanatory text, titles, or option rows do
not authorize an answer. Conversation prefixes (`●`, `•`, user/composer markers)
remain provenance even when they precede an exact quoted trust question; slicing
at the question must not discard them.

Native Codex 0.154.0 captures at 100 columns (2026-09-16) place
`> You are in /absolute/project/path` before the directory question. The question
and explanation begin on the same row and wrap:

```
Do you trust the contents of this directory? Working with untrusted contents comes with higher
risk of prompt injection. Trusting the directory allows project-local config, hooks, and exec
policies to load.
› 1. Yes, continue
  2. No, quit
Press enter to continue
```

Its hook gate renders `Hooks need review`, `1 hook is new or changed.`, and
`Hooks can run outside the sandbox after you trust them.`, followed by
`Review hooks`, `Trust all and continue`, and
`Continue without trusting (hooks won't run)` as numbered choices. Its footer is
`Press enter to confirm or esc to go back` — accepting only `esc to cancel`
incorrectly rejects this real dialog. These PTY captures supersede the earlier
0.144.4 binary-string evidence for those layouts. No captured path follows the
trust header; do not add generic path/prose acceptance based on that assumption.

The native Codex 0.154.0 input loop can swallow the first numbered confirmation:
the PTY write fulfills while the directory gate stays visible. In the 2026-09-16
high-trust probe, a manual repeat at eight seconds cleared that same gate; the
first write had already produced premature startup activity at roughly one second.
Numbered automation therefore retries every 250 ms for at most five seconds,
revalidates the same header and exact option identity before each write, and
reports answered only after the gate clears. Only the first write carries the
number; see "Codex numbered trust retries" below for what a retry may send. A native directory-to-hook transition
confirms directory clearance without sending an old answer to the hook gate.
An observed clear-and-reappear generation cancels the old attempt.

Cursor answers reread the frame before every selection and confirmation write. Both navigation
styles now belong to one session-owned coordinator: each observed dialog
generation owns its reservation, deadline, exact affirmative, and completion.
An old cancelled attempt cannot release or settle a reappeared gate. The five-
second bound starts at the first native-header candidate, including partial
painting. Candidate recognition holds input; only the stricter native-dialog
recognizer authorizes writes, and it requires the native explanatory copy above:
a bare header with affirmative rows (a forged or half-painted frame) is held and
never typed into. Every captured layout (Claude 2.1.206/2.1.252, the 2.1.274
binary's component, Codex 0.154.0) renders that copy with its header. Unknown replacement text is not clearance. Native
composer chrome or a verified successor gate confirms clearance; a bare caret
alone cannot distinguish a composer from a one-option dialog.

A stable unsupported or exhausted gate becomes recoverable `blocked` with the
existing attention rule id after five seconds, even when the terminal emits no
new data. This is the deliberate fallback approved for autotrust. A later valid
layout or new generation re-arms safe automation; an unchanged redraw does not
restart an expired loop. Once fallback is visible, the block remains until
verified clearance. Raw human keys remain available, while queued persona,
paste, and command input stays held. Stop, kill, teardown, startup cleanup and
PTY exit cancel pending automation and timers before disposal. Only a rejected
PTY write belonging to a still-live matching attempt emits
`startup_prompt_write_failed`; cancellation and late settlement stay quiet.

**The five seconds count on-screen time only (Claude 2.1.310, 2026-10-25).** After
an accepted folder-trust answer, Claude erases the dialog at once but takes
seconds to paint its composer. In 30 fresh-folder `autotrust` launches, 10 at a
time (load average 30–70), the dialog was erased 0.17–0.98 s after it first
painted. The screen then stayed blank, then showed only the welcome banner
(logo, version, model, path, one rule). The composer painted 4.0–8.9 s after
the dialog first appeared. That deadline used to run from the first candidate to
verified composer clearance, so it timed Claude's boot rather than the gate.
Every launch whose composer came after 5 s went `blocked` with
`claude-workspace_trust-prompt` attention at +5.0 s, then `ready` when the
composer painted: 17 of the 27 launches that reached `ready`. At each of those
blocks the rendered frame held no trust dialog. Another 100 launches the same
day show the same split: 51 of 94 `ready` launches blocked; the dialog was
erased 0.05–1.06 s after first paint; erase to composer took 0.72–8.23 s, median
4.6 s. Headless `elwood run` treats that rule id as a human prompt and kills the
session: 5 of 7 runs, 14 at once in fresh `$TMPDIR` folders, failed with
`blocked_prompt`, against none with this change.

The budget therefore elapses only on frames that show the gate: it is five
seconds of cumulative visible time. A frame without it pauses the budget, and
the same gate's return resumes the remainder rather than a fresh five seconds,
so a gate that flickers still exhausts one budget. Only a gate that stays absent
from its departure through verified clearance is guaranteed never to block. The
input hold does not change: it lasts until verified composer or successor
clearance. No separate post-answer
bound replaces the old one. Boot time grows with load, so any fixed bound only
moves the false attention later. A CLI that never paints after an answered gate
leaves the session held, as before, but no longer reported as a trust prompt.
Interleaved under the same load, 16 at once, the old rule blocked 10 of 16
launches and this one 0 of 16, with 10 boots over 5 s in each arm. Sixteen
launches matter: eight on a quiet machine all booted in under 4 s and never
reached the condition. The sanitized PTY bytes of the slowest launch are in
`tests/fixtures/claude-2.1.310/trust-slow-boot/`;
`tests/claude/session-trust-slow-boot.test.ts` replays them at their recorded
times. `tests/e2e/trust-slow-boot-claude.e2e.ts` launches 16 fresh folders at
once against the real CLI and logs how many boots exceeded 5 s. C-ATTN-03,
C-TRUST-01.

**An answer is reported when the composer verifies it, not when the dialog
leaves (Claude 2.1.310, 2026-10-25).** The blank and banner-only frames between
the erased folder-trust dialog and the composer show neither the gate nor a
composer. The attempt read them as its choice vanishing and cancelled itself
quietly, which is right for a choice lost before its Enter. By then, though, the
confirming write had fulfilled, so the cancellation discarded a real answer.
None of the 30 fresh-folder `autotrust` launches above emitted `startup_prompt`,
although the 27 that reached `ready` had answered their gate. A confirmed
attempt now waits through dialog-free frames and writes nothing; it re-reads the
screen only when a new frame renders, so the wait holds no timer. Verified
composer or successor clearance reports it once. If the same gate returns, the
attempt answers again within the remaining on-screen budget. Expiry, a changed
gate, a complete off-allowlist gate, or closing cancels it without a report. With this change, all 21 launches of the two Claude trust e2e
files (5 at once, then 16 at once with every composer more than 7.5 s after the
prompt) reported exactly one `startup_prompt`, `sent home+down+enter`. Swapping
in the previous trust code failed both files: no launch reported its answer.
Codex 0.164 shows its directory-trust prompt in a fresh git folder, and its
answers were lost the same way: in four rounds of 4 such launches at once, the
previous code reported 0 of 16 answers and this change 16 of 16, each `sent 1`.
`tests/claude/session-trust-slow-boot.test.ts` replays the recorded launch and
requires exactly one report, and both Claude trust e2e files require one
`workspace_trust` `startup_prompt` per launch that names a write the launch made. C-CLAUDE-10,
C-TRUST-01.

Both CLIs reword gates often, so an off-allowlist gate behind a recognized header
prefix fails closed: a header-shaped region (`headerStart` in
`src/core/trust/dialog.ts`) with real header text, selectable options, only
option rows and a frame-ending native footer beneath it, and no conversation row
above it holds input as `<agent>-unknown_gate-prompt` and is never written to. Both
CLIs paint the composer below conversation content, so quoted or model-written
question-plus-list prose fails that tail test. The footer is required because options
paint before it. A gate whose first words fall outside `headerStart` (e.g.
`Allow ...?`) is NOT held: a purely structural recognizer would also catch dialogs
Elwood drives itself (the Codex model picker ends in `Press enter to confirm or esc
to go back`).

A fulfilled write alone does not prove the gate cleared. Real-CLI checks use a
separate raw visibility oracle so production recognition failures cannot make
the tests report the gate absent. Sanitized native Claude 2.1.274 and Codex
0.154.0 post-trust composer captures anchor the positive-clearance tests.
A no-model Codex resize probe at 100×12, 100×8 and 100×6 confirms that the welcome
box can scroll away while its composer and model/reasoning/path footer remain.
Those native rows also prove clearance; welcome presence is not required.

### Codex numbered trust retries (0.164, 2026-10-25)

Under `autotrust`, Codex 0.164 sometimes received "1" as a user message right
after its directory-trust gate. Elwood wrote `1\r` when the `Folder access` gate
painted, then wrote `1\r` again 250 ms later because the frame still showed the
gate. Under load Codex had taken the first answer but painted its composer after
the retry, so the second `1\r` submitted "1" as a turn. In one capture the writes
landed at 21.26 s and 21.52 s, and the transcript then showed `› 1` with the turn
running at 24.7 s.

Codex also discards keys written as the gate paints. In 8 fresh git folders
launched at once (load average about 140), with `autotrust` off and a probe
typing `1\r` 8–33 ms after the gate's first frame, 7 of the 8 answers were
dropped. No output followed for 3 s. A bare `\r` then confirmed the
highlighted `› 1. Trust and continue` 24–156 ms later in all 7. The eighth
answer (written 13 ms after the gate's first frame) was taken. Once each
composer painted, a bare `\r` on the empty composer submitted nothing in 8 of
8: no hook fired, no `Working` row, and the status stayed `ready`. Typing `1`
alone selects option 1 without confirming it (the gate stayed for 40 s). So
neither a time limit nor new output can tell a dropped answer from one Codex
is still processing, and a dropped answer produces no output to wait for.

Elwood therefore types the number in its first write to a gate, and never
again on a stale frame alone. While the
rendered caret is on the affirmative, a Codex retry is Enter alone, every
250 ms within the gate's five on-screen seconds. On the gate it confirms the
highlighted affirmative; on the empty composer it does nothing. Claude never
gets a bare Enter (its list remounts with the caret on the decline; see the
next section), and Codex's hook gate opens with its caret on `Review hooks`.
Those numbered gates are answered again only after a frame rendered from
output that arrived after the last write still shows them. Once Elwood has
started writing the number to a gate, every later attempt at it retries this
way, even when that write or a retry was rejected, since a rejected write may
still have reached the CLI. Only another complete dialog replacing the gate
makes its return a fresh gate that gets the number.
`tests/codex/session-trust-slow-answer.test.ts` covers both cases.

Measured with 8 fresh git folders launched at once per round and two rounds per
arm, at load average 20–60 (leaked shell processes were also slowing the
machine): on the previous code, 9 of 16 launches typed `1` into the composer (2
to 11 `1\r` writes each), and only 5 of 16 reported their answer. With this
change, 0 of 16 did: each typed the number once, then 1 to 15 bare Enters, and
all 16 reported `sent 1`. `tests/e2e/trust-retry-codex.e2e.ts` makes the lag
certain by holding Codex's output from Elwood for 2 s after the answer while
Codex runs normally. On the previous code it failed both runs: seven more `1\r`
writes reached the composer, "11" was submitted, and the model answered "What
would you like me to do with 11?". With this change it passed 3 of 3. Freezing
Codex itself (SIGSTOP for 2 s right after the answer) does not work as a test:
Codex then exits with `timed out discarding buffered terminal input`, whatever
Elwood types. Codex 0.164 discards buffered input at screen changes like this
one, and a stalled discard is fatal.

### Claude trust selection reset (2.1.310, 2026-10-25)

Under `autotrust`, 7 of 60 fresh-folder launches of Claude Code 2.1.310 exited
with code 1 at the folder-trust gate on a loaded machine (load average 60–160 on
16 cores, three to six launches at once). Every failure had the same shape. Elwood
wrote `\x1b[B` (twice in two runs, the second a 250 ms retry), Claude painted
`❯ Yes, I trust this folder`, and Elwood wrote a bare `\r`. Claude then repainted
`❯ No, exit` without any key from Elwood and ran its exit sequence
(`\x1b[?1006l…\x1b[?25h`). In two runs the repaint and the exit sequence arrived in
one output chunk.

The 2.1.310 binary explains it. `TrustDialog` renders its confirm list with
`cancelFirst`, `focus: "cancel"` and a React key of `"held"` or `"settled"`. The key
flips to `"settled"` 150 ms after the dialog mounts. An Enter within 150 ms of mount,
or of an earlier refused Enter, is refused, and the refusal flips the key back to
`"held"` for another 150 ms. Each key change remounts the list with the cursor on
"No, exit". On a busy machine the settle timer is already overdue when Claude next
reads stdin, so it runs first. The Enter that Elwood decided from the `❯ Yes` frame
is then processed on the remounted list and confirms "No, exit". A probe that sent
only Down at first paint saw `❯ Yes` and then `❯ No, exit` 90 ms later, with no
Enter. A refused Enter only resets the cursor: that is the "first Enter is lost"
pattern in successful runs (Down, Enter, reset, Down, Enter). Separately, Down on
the last row wraps to the first. In one run a stalled first arrow and its 250 ms
retry both landed, painting `❯ Yes` and then `❯ No, exit`; an Enter decided between
them would also confirm "No, exit". Every installed binary from 2.1.268 to 2.1.310
carries the same remount key on this dialog (the 150 ms window was read from 2.1.305
and 2.1.310), and the MCP-server dialog uses it too.

Claude's list binds `home` to `select:first` and `end` to `select:last` in every
installed binary from 2.1.268 to 2.1.310. A live 2.1.310 probe confirmed that Home
(`\x1b[H`) and End (`\x1b[F`, `\x1b[4~`, `\x1bOF`) move the trust cursor absolutely
and repeat harmlessly. Written as one chunk, `\x1b[H\x1b[B\r` confirmed "Yes" in
every probe and every fixed launch, including launches where the remount ran just
before the chunk was read.
The list's key handlers read focus through a synchronous getter, so one chunk's keys
see each other's effect. Inside the 150 ms windows the chunk is refused, which is
harmless, and the next retry succeeds. Elwood therefore writes Home plus one Down
per row above the affirmative while the rendered cursor is elsewhere. Once the
cursor is on the affirmative, it writes that selection and Enter as one write.
Relative arrows and bare Enter are never sent. With that rule, interleaved with the
failing runs under the same load, 0 of 51 launches exited. In 7 of them Claude
repainted `❯ No, exit` after the combined write and still accepted it; with a bare
Enter that interleaving exits. `tests/unit/trust-claude-selection-reset.test.ts`
replays the real 100×30 frames (`tests/fixtures/claude-2.1.310/folder-trust-*.txt`)
against a model of this dialog. `tests/e2e/trust-prompt-claude-concurrent.e2e.ts`
launches five fresh folders at once and checks every trust write at the PTY
boundary.

### Codex takes a trust answer before Elwood's frame shows it (0.164, 2026-10-25)

Elwood decides each startup retry from the frame it has rendered, and under load that
frame trails Codex. Codex 0.164 can take the trust answer and draw its composer while
Elwood's frame still shows the folder-access gate. A retry decided from that stale
frame lands in the composer. Keys a caller types in that window also reach the
composer, so a `1\r` retry written after them would add a digit to the caller's draft
and submit it as a turn.

`tests/e2e/trust-caller-input-codex.e2e.ts` makes the window certain. It holds Codex's
output from Elwood for 4 s after the first `1\r`, and types `hello` as soon as Codex's
raw output draws its configured composer (the footer naming the session's model). On
`main` at 6e396099, at load average 34, Elwood kept retrying the stale gate every
250 ms: 14 more `1\r` writes followed `hello`. Raw caller input now hands the startup
prompt on screen to the caller before its keys are written (C-TRUST-01). In two runs
with that handoff, nothing followed `hello`.

The Codex update skip has the same ordering. A `2` decided from a stale update prompt
would reach whatever Codex drew next; on the trust gate, `2` is Quit. Caller input
ends the skip, and the update stays the caller's until a native composer clears it,
because Elwood's frame can lose and regain a stale prompt in between (C-CODEX-12).

### Native Codex startup warnings

Codex 0.154.0 normally collapses MCP failures to
`⚠ 1 MCP startup issue · ctrl + t for details`. Its Ctrl+T overlay retains the
canonical detailed MCP and login warning rows beneath the boxed welcome header.
The collapsed count cannot supply server names or recovery instructions; Elwood
does not send Ctrl+T automatically. Captures and the local failing-server/401
real-CLI test verify the detailed rows. The current welcome chrome and native
warning prefixes distinguish these banners from conversational quotations.

**Codex 0.164.0 shows only a badge (2026-10-25).** In C-E2E-09's native run (an MCP
server answering 401, `startup_timeout_sec = 2`), the welcome is no longer boxed, and
the only startup trace is `⚠ 1 warning · f2 to view` at the end of the composer's
model footer, which the composer clearance already strips. Ctrl+T opened the
`/ T R A N S C R I P T /` overlay. It holds both canonical rows, the `elwood_probe`
not-logged-in row with its `codex mcp login elwood_probe` command and
`⚠ MCP startup incomplete (failed: elwood_probe)`, under an unboxed
`>_ OpenAI Codex (v0.164.0)` and above the overlay's own key hints. That overlay is
Codex's transcript view, where the conversation also renders, so it is not a startup
region; the parser finds no welcome box there and returns nothing. Elwood sends neither F2 nor Ctrl+T, so on 0.164 a
session emits no MCP startup warning: the count names no server and no recovery
command (PRD §5.7, C-CODEX-09). The captures are
`tests/fixtures/codex-0.164.0/boot/warning-badge.txt` and
`warning-transcript-overlay.txt`; C-E2E-09 asserts the badge, that its frame reads as
the composer, and that no warning parses from it.

Native 0.154.0 startup renders no `•`/`●` row at any point: recorded frame by frame
(2026-09-17) through the directory gate, hooks gate, welcome, and composer with
both an MCP endpoint that fails at once and one that accepts the connection and
never answers (the collapsed warning appears after ~10 s with no boot spinner).
Warning recognition therefore ends at the first assistant-marker row or the
first caller-side write, whichever comes first; after that a copied welcome box
whose own marker has scrolled away is content. A CLI version that painted a `•`
boot spinner before its warnings would lose those warnings rather than forge any.

### Bypass-permissions acceptance dialog (`--high-trust`)

Claude Code carries a one-time disclaimer for bypass mode. Its wording, taken
from the 2.1.268 binary (it is not in the public docs), is:

```
WARNING: Claude Code running in Bypass Permissions mode
In Bypass Permissions mode, Claude Code will not ask for your approval before running potentially dangerous commands.
By proceeding, you accept all responsibility for actions taken while running in Bypass Permissions mode.
  Yes, I accept
  No, exit
```

The acceptance is persisted in Claude's global config as
`bypassPermissionsModeAccepted` (the binary describes it as "Whether the user has
accepted the bypass permissions mode dialog"), and `--bg` refuses bypass mode
until it has been accepted once interactively, so the dialog is at most
once-per-machine. On 2.1.268 (Claude Max account, macOS) the dialog did not render
at all, through Elwood's `--permission-mode bypassPermissions` launch or a raw
`--dangerously-skip-permissions` one, and no `bypassPermissionsModeAccepted` key
existed anywhere under `~/.claude*`. The likely reason is a user setting, not the
version or account: the developer's `~/.claude/settings.json` sets
`"skipDangerousModePermissionPrompt": true`. On 2.1.310, in a config that has never
accepted the dialog, that setting alone decides whether it renders: in an empty
`CLAUDE_CONFIG_DIR` (no settings, never accepted) the dialog renders, and adding the
setting there sends the session straight to the composer. The 2.1.310 copy
is longer and opens with the cursor on the decline
(`tests/fixtures/claude-2.1.310/bypass-permissions-{100,200}.txt`):

```
WARNING: Claude Code running in Bypass Permissions mode

In Bypass Permissions mode, Claude Code will not ask for your approval before running potentially dangerous commands.
This mode should only be used in a sandboxed container/VM that has restricted internet access and can easily be restored if damaged.

By proceeding, you accept all responsibility for actions taken while running in Bypass Permissions mode.

https://code.claude.com/docs/en/security

❯ No, exit
  Yes, I accept

Enter to confirm · Esc to cancel
```

Until the native-copy pattern accepted the sandbox sentence and the link, Elwood
held this dialog as unrecognized prose and the session stayed `blocked` under
`autotrust`. The suite never saw it because the developer's setting hid it, so
whether it appears depends on the user's settings and Elwood must be correct in
BOTH states:

- The dialog is an allowlisted trust prompt (`bypass_permissions`), answered
  under `autotrust` by the same header-anchored, numbered-or-cursor machinery as
  folder trust. The header pattern anchors on `running in Bypass Permissions
  mode` so the always-present `bypass permissions on` footer can never match, and
  the affirmative matcher is specific to `Yes, I accept` (never a generic yes).
- When the dialog does not render, nothing is written and the session simply
  reaches `ready`; `tests/e2e/high-trust.e2e.ts` asserts a `bypass_permissions`
  `startup_prompt` exactly when the dialog was seen, and logs which case ran.
- The folder-trust gate still renders first under bypass mode (see above), so a
  fresh temp workspace answers `workspace_trust` and then, if shown, the
  disclaimer.
- `--dangerously-skip-permissions cannot be used with root/sudo privileges for
  security reasons` is the CLI's own refusal; Elwood does not special-case it —
  it surfaces as the ordinary start failure with the CLI's message.

**Do not equate `autotrust` with readiness until the real gate clears.** The
automation gate holds the 10 s initial-ready fallback and queued input from the
first native trust candidate. Successful bounded automation does not report a
human block; unsupported or exhausted attempts transfer to the recoverable block
above. C-E2E-09 requires both `ready` and a cleared trust screen; an unanswerable
real frame is a failure, not a skip.

The responder emits one transient `attention` when a recognized header and its
native body paint before the affirmative option. A header whose body has not
validated is held silently: it emits no transient `attention`, only the
five-second fallback if it never completes. A headless owner must ignore that
transient only when its trust policy already authorizes the exact allowlisted
prompt; `--no-trust` and generic permission dialogs remain human blocks. The startup replay buffer can
deliver this attention after the responder has already continued, so treating
every attention event as fatal produces a false `blocked_prompt`.

## Codex in-TUI update prompt (and the restart loop)

Independent of the `autoupdate` preflight (`codex update` run before spawn), the
Codex TUI can show its OWN "update available" prompt at launch. Elwood **only selects a verified safe skip choice** — it never selects "Update now" — because letting the live TUI update
itself restarts Codex out from under the PTY session. The real update is the
preflight; the in-TUI prompt is a nuisance to dismiss.

**The trap (reported against the field, 2026-08):** an in-TUI update that a human
"accepts" (or that Elwood used to leave latched) restarts Codex, the update does
**not** take (a partial download, a managed install, contention), and the SAME
update screen returns — an infinite loop stuck on the update screen. The fix is an
**edge-triggered** skip: skip once per appearance. Unknown or blank replacements
keep automation revoked until authoritative native composer clearance or fresh
first-party banner evidence permits a new appearance. A verified clear can re-arm
a new bannered appearance after the restart; retained composer text beneath a
replacement cannot. The old attempt stays revoked even when a new one is authorized.

Version-coupled behavior learned here:

- Every automated selection requires the current validated first-party banner and
  its current safe numbered choice. All bannerless continuations are withheld,
  including previously observed number/label bindings. The banner activates the
  blocker before choices paint, and retained input remains held until positive
  native composer clearance. Historical accumulated-buffer matching and later
  safe-option-only continuation inference are no longer authorization rules.
  The earlier 0.155.1 full-menu fixture captures preserve the banner at every
  observed size; those fixtures do not establish a genuine bannerless repaint. C-CODEX-12.
- Captured Codex menus list `Update now` before safe choices. Selection respects
  that ordering, excludes the update action, and compares the current bounded
  option snapshot before each write. Removal or renumbering of a safe choice
  invalidates the prior retry; a fresh bannered safe block gets a new appearance.
  Old and new numbers are never accumulated into one authorized set.
- Update recognition and input blocking have different lifetimes. An unknown
  replacement is no longer an update. Without a prior recognized update it does
  not create a retained update hold, so queued paste and Enter remain eligible.
  Once an update was recognized, the session retains its input hold until native
  composer and visible cursor in one completed render prove clearance, with no
  working-title signal. The title may be absent or an ordinary directory name. A
  partial repaint or bare caret cannot release it. Specific trust rules keep their
  own labels; otherwise an unowned retained hold reports `codex-unidentified-dialog`.
  Pending automated trust owns its partial repaints and suppresses that generic
  label until its input hold ends.
- Option labels drift by version. Older codex (0.132/0.133) rendered a numbered
  dialog ("1. Update now / 2. Skip / 3. Skip until next version"). In the installed
  0.149.1 binary, the upgrade notice strings extracted from the native binary read
  like a **passive banner** (`<version> to update.` +
  `https://github.com/openai/codex for installation options.`) rather than a
  numbered dialog — so the interactive dialog is not guaranteed on every version.
  The skip is written ONLY when a numbered skip option is actually present
  (`safeUpdateOption` → `undefined` ⇒ no write), so a passive banner is a harmless no-op.
  If the only skip-shaped choice precedes the update action, the helper also returns
  `undefined` and no key is written.
  Every retry revalidates that the frame still belongs to the captured first-party
  update-prompt generation and uses the safe option's current number. The current banner must remain visible; a bannerless repaint cannot inherit a
  digit from a cleared/reappeared prompt. A prompt that remains blocking
  but cannot be safely answered becomes `blocked_prompt` after the bounded
  responder/grace window, including runs without a whole-invocation timeout.
  The match set is unit-tested against captured
  layouts; the pinned 0.155.1 native experiment below used controlled update metadata. `codex-update-selection.e2e.ts` also replays the documented option
  layout and an adversarial reordered variant through a real PTY and emulator;
  its child acknowledges the physical skip digit it received. If Codex changes the dialog wording, this is the first thing to
  re-capture.

**Concurrent-start failure (verified against codex-cli 0.152.1, 2026-09):** the
native TUI updater prints `Updating Codex via ...` and runs the same global npm
installer as the preflight. If queued startup input confirms its default "Update
now" action while another host is updating, npm races creation of the shared
`bin/codex` symlink and one installer fails with `EEXIST`. Update screens are
therefore input-blocking facts, not only responder hints: readiness and paste
submission remain suspended until the rendered update frame clears, even after
the skip key is written. The prompt recognizer accepts the known first-party
versioned banner before options paint, plus option-only frames when BOTH "Update
now" and a safe skip/later choice are present. Those bannerless blocks remain recognition evidence only. No bannerless frame
authorizes automation; the input hold lasts until positive native composer clearance. Generic agent prose
containing "update available" and the actual 0.149.1 passive installation notice
do not block.

A fulfilled update digit write is not clearance evidence. Update settlement uses
the same native composer, cursor, title, and completed-render predicate as the
retained input hold. It also reads the frame observer's existing hold when old
composer chrome survives beneath replacement text. Missing readers and replacement
dialogs cancel quietly.

The preflight adds a second boundary because global installers can also race
across separate Elwood parent processes. A per-user/per-adapter atomic lease in
the account cache (independent of `TMPDIR`) surrounds the required existence check
and updater. Contenders wait without blocking the event loop, then invalidate
their local version and capability caches and validate the installed binary
without launching another updater. The lease records a PID and unique generation:
a live owner is never evicted solely because the 30 s stale bound elapsed,
dead-owner recovery is serialized, and cleanup removes only the generation it
owns. Caches are invalidated after failed attempts too because npm can partially
mutate the installation before returning nonzero.

## macOS PTY teardown

After a Codex PTY leader exits on macOS, signalling its process group can return
`EPERM` for a few scheduler ticks before the same group reports `ESRCH`. Treating
that first result as permanent made otherwise-successful headless runs end as
`cleanup_failed`. After Elwood has observed the PTY exit, process-group reaping
therefore retries only this transient `EPERM` four times at 25 ms intervals;
other errors, pre-exit errors, and persistent `EPERM` still fail. Controlled
shutdown also leaves the reap to its owning termination path instead of emitting
a competing best-effort warning. Verified against Codex 0.153.3 on macOS.

## Hook and MCP process groups (2026-10-25)

Claude Code 2.1.310 and Codex 0.164.0 start every hook command with `setsid()`.
Measured on macOS with `ps -o pid,ppid,pgid,command` and `os.getsid()` while a
slow hook was in flight under a real Elwood session:

- Claude runs a hook as a direct child of the CLI (`ppid` = the PTY leader) whose
  `pgid` and `sid` both equal its own pid. A compound command runs as
  `/bin/sh -c '<command>'`; a plain one such as Elwood's
  `'<node>' '<bridge>.mjs'` is executed directly. An Electron host's
  `ELECTRON_RUN_AS_NODE=1 …` command needs the shell, consistent with the
  reported orphan `/bin/sh -c node hook-bridge.mjs`.
- Codex runs a hook as `/bin/zsh -c '<command>'` (the user's shell), also with its
  own `pgid` and `sid`. Codex started an MCP server (`node ./scripts/start-mcp.mjs`,
  from a plugin it installed in the sandboxed `CODEX_HOME`) in its own process
  group but inside the leader's session.
- The children the CLI starts without detaching, such as Claude's IDE probe
  (`ps aux | grep …`), stay in the leader's group.

So the leader-group SIGKILL (`kill(-leader)`) cannot reach a hook. Once the
leader dies the hook is reparented to PID 1 and nothing ties it to the session;
only the parent-pid chain links a hook to its leader, and only while the leader
lives. With the group reap alone, `teardown()` during a `SessionStart` project hook
running `sleep 45` resolved in 25 ms and left that `/bin/sh` and its `sleep` alive
under PID 1. `stop()` while a `SessionEnd` hook ran `sleep 46` timed out after
5 s; Claude waits for `SessionEnd` hooks on SIGTERM, so Elwood escalated to SIGKILL
and left the hook running. On Codex, `teardown()` during a `UserPromptSubmit`
config hook left the `zsh`/`sleep` group alive, and the MCP server group outlived
the CLI briefly. Elwood's own bridge processes died only because teardown then
closes the bridge socket; the reap itself never reached them.

When Claude exits on SIGTERM within the graceful window it kills its in-flight
hooks itself: a `stop()` during the same `sleep 45` hook exited in about 1 s with
no survivors. On macOS, `killpg` on a group whose members are all unreaped zombies
returns `EPERM`, not `ESRCH`. `src/runtime/shutdown/process-table.ts` reads the
table and finds these groups by walking parent pids from the leader.

Elwood therefore walks the tree only before a SIGKILL it sends to a live leader. It
SIGSTOPs the leader's group and lists `/bin/ps -A -o pid=,ppid=,pgid=,stat=`. A
group id from `ps` is only a snapshot, `kill()` returning means the SIGSTOP was sent,
not delivered, and `ps` reads each process's state at its own moment (on macOS it
takes the set of pids first and each row's state afterwards). So Elwood relies only
on a process that read stopped (`stat` starting with `T`), inside a group it stopped,
in two consecutive listings. A group that holds a live descendant is stopped once
such a process is a parent of one of its members: that parent cannot reap the
member, so the group keeps its id until the signal. The walk succeeds only on a
listing that shows the leader live, leaves no live group unreached, and holds every
live process in every stopped group that way, the leader's included, so none of them
can have started a process the listing missed; a leader exit observed first fails it,
because the leader's detached children are then out of reach. Then the stopped groups
are SIGKILLed deepest first
(`src/runtime/shutdown/detached-sweep/`). That is two listings with no hook in
flight, and two more per level of nesting. A process whose own parent exited before
the walk is already under PID 1 and out of reach. macOS refuses a stop or a kill of
a group whose members are all unreaped zombies with `EPERM`, so either counts as a
failure only if a later listing still shows a live member of that group.

`killpg` is not atomic against `fork` (measured 2026-10-25, Claude 2.1.310, macOS
Darwin 25.5): a child forked while the group's SIGSTOP goes out can miss it and keep
running. The PTY leader is the user's interactive login shell (§4.2), and in one
Claude `teardown()` out of nine, with no hook in flight, `claude` had already exited
and the shell was running a `$(… | tr …)` pipeline from the user's shell
configuration. One subshell of it read `R` on every listing for the whole
three-second deadline while the rest of the group read `T`, so the leader's group was
never held and `teardown()` rejected. A zsh group forking `$(echo a | tr a b)` in a
loop, SIGSTOPped once, left one member running in 1 of 150 stops, and a second
SIGSTOP stopped it every time. So any listing that shows a live process in a stopped
group not stopped sends that group SIGSTOP again: the leader's only while its exit
has not been observed, a descendant group because its held parent keeps the id. A
listing cannot tell a stop still in flight from a missed one, and a second SIGSTOP
to a stopped process does nothing, so the walk does not try to. With the re-stop, 40
of 40 real no-hook teardowns completed, 5 of them sending the leader's group a
second SIGSTOP; without it, 1 of 9 had rejected.

The walk's cost, measured 2026-10-25 on Claude 2.1.310 on a shared machine: one `ps`
listing of about 1,800 rows took 110–240 ms at load 33–35. At load 19–26, ten
`teardown()`s with no hook in flight took 81–291 ms (median 227, two listings), and
ten with a `SessionStart` hook in flight 175–567 ms (median 373, four), against 2–3
ms and 7–18 ms with the walk disabled, where the in-flight hook survived every time. `tests/e2e/teardown-reap.e2e.ts` drives the
real CLIs: Claude `teardown()` with a hook in its own group, a `stop()` whose
`SessionEnd` hook outlasts the graceful window, and Codex `teardown()` with a hook.
With the walk disabled all three fail with the hook still running.

Codex also starts a shell of its own, not a hook, that the walk has to reach
(measured 2026-10-25, Codex 0.164, macOS Darwin 25.5). A few seconds after launch
(2.1–2.6 s after `startCodex` was called, in these runs) it snapshots the user's
shell environment with `/bin/zsh -lc '<script>'`. The script sources
`$ZDOTDIR/.zshrc`, else `$HOME/.zshrc`, then prints the environment. The shell is a
session leader of its own (`stat` `Ss`, `pgid` equal to its pid) whose parent is the
`codex` leader. With a normal profile it lived about 0.8 s. A `.zshrc` that sleeps
only when non-interactive (`[[ -o interactive ]] || sleep 120`) holds it open without
slowing the PTY's own interactive login shell, and with that profile:

- `teardown()` with the group reap alone left the `zsh -lc` and its `sleep` running
  under PID 1. With the walk, `teardown()` and `kill()` reaped both.
- `stop()`'s SIGTERM: Codex exited in about 190 ms. The leader exited within the
  graceful window, so there was no walk, and both the `zsh -lc` (now under PID 1)
  and its `sleep` survived.
- A human at the terminal, `/quit` then Enter, or Ctrl-C twice: Codex exited about
  6 s after the keys. The `zsh -lc` was gone, but the profile's `sleep` survived
  under PID 1.

Claude 2.1.310 under the same profile started no shell that sources `.zshrc`
non-interactively, and nothing survived. So the premise behind the graceful-stop
exception, that the CLI's own SIGTERM shutdown ends its detached descendants, holds
for Claude's hooks but not for this Codex shell: a `stop()` during the snapshot
leaves it running. `tests/e2e/codex-snapshot-reap.e2e.ts` holds a snapshot open
this way and checks that `teardown()` reaps it.

## Codex 0.164 starts an app-server daemon per `CODEX_HOME` (2026-10-25)

Codex 0.158.0 and later list the feature `daemon_auto_start` as stable and on (0.156.1
lists it as experimental and off; 0.155.1 does not have it). With it, the Codex 0.164.0
TUI can start a managed app-server daemon for its `CODEX_HOME`. Measured on macOS
(Darwin 25.5) with fresh homes: 11 of 14 launches without the hook-trust bypass started
one, the earliest beginning its install 1 s after launch, and none of 5 launches with
the bypass did, one of them an Elwood session watched for 17 s. What decides it was not
determined. The e2e suite's removed homes had left 29 of these daemons running by that
evening.

- It installs a copy of the CLI, about 260 MB, at
  `$CODEX_HOME/packages/app-server-daemon/releases/<version>/bin/codex`. One such home
  measured 453 MB.
- It runs `codex app-server --listen unix:// --analytics-default-enabled --managed-daemon`
  and `codex app-server daemon pid-update-loop`. Each is a session leader of its own and
  a child of the TUI, reparented to PID 1 when the TUI exits. The control socket is
  `$CODEX_HOME/app-server-control/app-server-control.sock`, pid files are under
  `$CODEX_HOME/app-server-daemon/`, and a socket directory and lock are under
  `/tmp/codex-daemon-<uid>/`. Plugin MCP servers (`node ./scripts/start-mcp.mjs`) run as
  its children.
- The TUI then reads through it as client `codex-tui`. The daemon's rows in
  `logs_2.sqlite` show `account/read`, `config/read` (the project trust read),
  `hooks/list`, and `model/list`.
- It outlives the TUI. Those 29 daemons had started 14 minutes to 1 h 49 min earlier,
  their homes removed seconds after, and were all still running, each holding its
  deleted binary. They refreshed `models_cache.json` and recreated `logs_2.sqlite`,
  `.sqlite-maintenance.lock`, and the plugin cache in the removed home. A removal that
  raced those writes failed with `ENOTEMPTY` (C-E2E-09, 1 run of 3).
- `codex app-server daemon stop`, run with that `CODEX_HOME`, stopped the daemon and its
  MCP servers but left the updater loop running. SIGTERM ended both within 2 s, and the
  daemon stopped its MCP servers and removed its `/tmp/codex-daemon-<uid>/` entries.
  `codex app-server daemon start` started both on every run, in about 2.5 s.

Elwood's sessions use the user's own `CODEX_HOME` and always bypass hook trust, so a
daemon there is the one the user's own Codex shares, as for a human at the terminal. The
e2e suite stops whatever still runs from a sandbox or from its default home before
removing it (`tests/e2e/scratch-processes.ts`). That is every process whose command line
names a path inside the home, plus its descendants: SIGTERM first, then SIGKILL 3 s
later. A sandbox where something will not stop is kept.
`tests/e2e/scratch-processes.e2e.ts` starts a daemon with `daemon start` and checks that
removing the sandbox, and exiting the run, stop it.

## Claude "Not logged in" is a distinct re-auth banner from "Login expired"

Claude's mid-session re-auth banners are NOT one string. Besides the lapsed/revoked
forms (`Login expired`, `Session expired`, `OAuth token revoked`), a session whose
auth is dropped entirely renders **`Not logged in · Run /login`**. The reauth
matcher (`isClaudeReauthRequiredText`, `src/claude/login/expiry-screen.ts`) must
recognize all of them — anchored on the `/login` recovery directive so an unrelated
mention of "login" (or a Codex MCP "not logged in" line) does not trip it. The
startup path already flagged the single-line `not logged in`; the gap was
MID-SESSION (a ready session logging out), where only the reauth matcher runs.
C-CLAUDE-17/18. Verified against the banner text the field reported; there is no
live-CLI e2e (it would mutate real auth), so the matchers are unit-tested against
captured strings.

## Claude login picker handshake (2026-09-23)

The `/login` command Enter and the method-picker selection Enter are distinct
writes in the production login driver. A fixture must await the command Enter
before painting the picker, then await the picker Enter before painting the auth
URL/code screen. Advancing on the first Enter can replace the picker before the
driver observes it. Reproduced through the real driver and fake PTY in
`tests/claude/session-login.test.ts` with a temporary 250 ms delay before the picker
stage: the old fixture missed the selection Enter; the corrected handshake passed.
This was a fixture reproduction, not a fresh native CLI authentication test; no
new CLI version or native capture was verified.

## Input / paste

- Caller and LLM text sent via `sendPrompt`/`sendMessage`/`sendGuidance` is
  sanitized (`sanitizePasteText`, `src/core/input/index.ts`): it strips
  bracketed-paste markers (`ESC[200~`/`ESC[201~`) and C0/C1 controls except
  tab/nl/cr, so text can't escape bracketed paste and inject a dialog-confirming
  Enter. C-API-40.
- Codex 0.156.1 renders each pasted tab as one space, regardless of column;
  consecutive tabs remain consecutive spaces. Pasted CR and LF start new rows.
  Verified in an isolated native PTY without submitting a model turn (2026-09-23).
  Recovery checks must use the sanitized payload and its rendered final line,
  otherwise removed controls or preserved tabs make a still-staged draft look absent.
- A submission's paste, Enter, and recovery Enters are **held while a blocking
  dialog is visible** (`holdWhileUnsafe` / `writeUnsafe`, `src/core/input/abort.ts`),
  so a dialog appearing in the paste→Enter window can't be auto-confirmed. "Visible"
  means observed: each write first awaits `terminal.settled()`, because a dialog can
  be received before it is rendered. xterm parses the first write after user input
  synchronously and later ones on a timer, so that window is real and input-dependent.
- **Writing a literal ESC byte in source is fragile** — it can be silently
  stripped by an editor/pipeline (this once neutered an interrupt e2e). Always
  write the escape sequence form (``), never a raw ESC character.

## Hook bridge request FIN and delayed decisions

The generated bridge child calls `client.end(request)` after connecting. That FIN
ends the request stream while the child still awaits the parent's decision. A
local real-socket reproduction with a handler held for 100 ms showed the default
Node server closing its reply side first: the child received empty EOF and exited
fail-open before the blocking decision existed. `allowHalfOpen: true` keeps the
reply side available until the handler settles. The server still ends and destroys
the socket after flushing its reply; shutdown still destroys pending sockets.

The regression runs the actual generated child against `HookBridgeServer`, checking
both the delayed blocking output/exit code and delayed handler-failure diagnostics.
This is a local bridge/process proof, not a new Claude or Codex CLI capture. PRD
§6.2/§6.3, C-HOOK-16.

## Hook bridge socket path length (macOS ~104-byte cap)

macOS caps a Unix domain socket path near 104 bytes (`sockaddr_un.sun_path`); binding
a longer path fails with `EINVAL`/`Ebadf`-class errors surfaced as `hook_bridge_failed`.
This is why the bridge socket lives OUTSIDE `stateDir` — a caller nesting Elwood state
even ~55 chars deep would otherwise make sessions unstartable. The socket home is under
`os.tmpdir()` (honors `$TMPDIR`); production paths look like
`/var/folders/xx/…/T/elwood-<16hex>/<8>.sock` (~90 bytes on macOS), under the cap.
`tests/claude/session-socket.test.ts` guards the invariant against the REAL production
path with a deeply nested `stateDir`.

**The trap that bit us twice.** The regression was never in production — it was in the
socket-*leak* tests' `isolateTmp()` helper, which nests a PRIVATE isolation dir under
`os.tmpdir()` (so a test sees only its own homes) and thereby ADDS a path segment
production never has. Stacked on the (later) fixed-length `elwood-<16hex>` home name,
that synthetic path crossed 104 bytes — but only where `os.tmpdir()` is already long
(macOS `/var/folders/...`). On Linux CI, `os.tmpdir()` is `/tmp`, so it passed there and
the failure was environment-masked. Fix: root the leak tests' isolation dir at a SHORT
`/tmp/elwood-sockhome-*`, not under `os.tmpdir()`. If you add any test that mints an
isolation dir the bridge binds a socket under, keep that root short and assert
`socketPath.length < 104` so a long-tmp machine can't hide the overflow.

## Headless command still drives the interactive TUI

The production `elwood` command is intentionally not a wrapper around either
agent's print/exec mode. It launches the same interactive PTY as the library,
waits on Elwood's established readiness and turn boundaries, and converts only
normalized activity into its text, JSON, or JSONL stdout protocol. Consequently,
every version-coupled behavior above—lazy Codex hooks, resume transcript settling,
trust and update dialogs, Claude cache confirmations, and final-answer transcript
phases—also applies to headless runs.

This matters when debugging an apparently silent command: raw terminal frames are
never a fallback output channel. Use `--verbose` for sanitized lifecycle progress,
or opt into the raw current-terminal mirror with `--head`, and run the real-CLI e2e
rather than adding screen scraping at the process boundary.
The compiled-bin smoke runs each agent in a separate child process so `--keep`
followed by `--resume --ephemeral` exercises persisted continuation, not an
in-memory session accidentally surviving in the test runner. C-CLI-01/10/11/12.

## Same-terminal headed display

`--head` must forward `terminal:data` bytes, not snapshots or parsed lines. Real
Codex 0.153.3 and Claude 2.1.261 both continuously repaint with cursor-addressing,
erase operations, spinner frames, cursor visibility, synchronized-output markers,
and OSC title changes; Claude also uses save/restore cursor operations. Re-rendering
normalized text cannot reproduce either TUI. The raw stream goes to terminal stderr
so final text/JSON stdout remains redirectable.

Raw delivery remains byte-exact but not unbounded: at most 4 MiB or 1,024 pending
frames may wait behind terminal backpressure. Elwood accepts no later frames after
overflow, drains the accepted prefix in order, restores the terminal, and returns a
normal nonzero result. This keeps a stalled terminal from turning a repaint-heavy TUI
into unbounded retained promises and buffers.

The outer stdin is put into raw mode while attached. This is required even though
v1 is view-only: otherwise terminal protocol replies and mouse/paste bytes can echo
into the display or leak into a parent shell. All input is discarded except Ctrl-C,
which enters the existing interrupt/kill lifecycle. On completion, restore the input
mode and emit a defensive VT reset before the final stdout record.

Four real-PTY edges were invisible to the unit fixtures:

- Codex's update dialog can raise a rendered blocking edge before the responder's
  safe Skip takes effect, and startup-attention replay can deliver that old edge to
  the CLI afterward. The CLI must ignore only this exact automation-owned label;
  generic permission dialogs still fail as `blocked_prompt`.
- Codex 0.153.3 can paint the numbered menu before its input loop accepts the first
  hotkey. A successful PTY write therefore does not prove the dialog cleared. The
  responder runs one bounded retry operation while a safe numbered option remains
  on the current rendered frame. A frame showing the option does not prove the key
  was ignored, so a retry can still reach the composer; it is Enter alone, or it
  waits for new output (see "Codex numbered trust retries"). Some PTY hosts close their input side before process completion and
  then return `EIO` from `setRawMode(false)`; contain only terminal-gone restoration
  errors because that host is already the sole remaining terminal-mode owner.
- Interactive login-shell probes can give their external command control of the
  caller's real terminal, then exit without restoring its foreground process group.
  A headed run subsequently restoring cooked mode is stopped by `SIGTTOU` before its
  defensive VT reset, leaving terminal query replies to leak into the resumed shell.
  Run probes in a detached process session so they keep interactive PATH resolution
  without participating in the caller terminal's job control.
- Current agent TUIs push Kitty keyboard enhancements with `CSI > flags u`. Head mode
  mirrors through session cleanup (so the drained final frames are shown), but an
  agent signalled or force-killed there is not guaranteed to emit its matching
  cleanup sequence, so head mode cannot rely on one reaching the physical terminal. The defensive reset must emit
  `CSI < u` before leaving the alternate screen; otherwise every later shell keystroke
  can remain encoded as a `CSI u` key event, making even a typed `reset` unusable.

Verified manually in a real PTY with successful headed turns on Codex 0.153.4 and
Claude 2.1.261, including terminal restoration and clean JSON terminal records.
C-CLI-18/C-CODEX-12.

## Interactive mode, session listing, and model listing

`elwood interactive` is the one command that does NOT drive the interactive TUI
through Elwood: it spawns `claude`/`codex` directly with inherited stdio and the
adapters' shared launch-argument builders, so every dialog the headless path
automates is the user's to answer. Verified in a real PTY on Claude 2.1.268 and
Codex 0.153.4:

- Codex shows its in-TUI update prompt first, then the directory-trust prompt
  ("Do you trust the contents of this directory?"), before the `›` composer. A
  PTY driver must answer both (Skip = `2`, Yes = `1`) before the composer
  appears; answering `2` to the trust prompt ("No, quit") exits 0. Codex draws
  words with cursor moves, so match dialog text with `\s*` between words. A
  typed `/quit` + Enter did not end the idle Codex TUI within 10s; its idle
  double Ctrl-C did (status 0), so the e2e driver quits Codex that way.
- Claude in a fresh temp directory went straight to the `❯` composer here, and
  `/exit` returned 0. The footer's "don't ask on" came from the user's own
  `~/.claude/settings.json` `permissions.defaultMode`, not from Elwood: with no
  configured posture Elwood passes no `--permission-mode` (source `built-in` is
  omitted), which is exactly the direct-launch experience.
- `elwood interactive <id>` after a headless `--keep` run reopened the prior
  conversation (the kept prompt and answer were on screen) via
  `claude --resume <conversation id>` in the stored workspace, and Claude
  printed its own "Resume this session with: claude --resume …" on exit. The
  Elwood record's `lastUsedAt` did not change, confirming no state writes.
- A stored headless session carries `permissionMode: dontAsk`, so an interactive
  resume of it runs Claude in don't-ask mode until `--claude-permission-mode`
  overrides it (documented in the README).

`elwood models` reuses the headless facade plus `CliLifecycle`, so timeout,
SIGINT, blocked prompts, and teardown behave as for a run. Real Claude lists
five rows in ~6s; real Codex six rows in ~5s. Two environment facts matter:

- When Elwood itself runs nested inside a Claude Code session (`CLAUDECODE` and
  `CLAUDE_CODE_*` set), claude >= 2.1.201 skips transcript persistence for the
  nested instance; a headless run then fails `wait_timeout` ("transcript did not
  catch up after ready"). The e2e helper strips those variables; do the same
  for manual smoke runs.
- **Claude 2.1.310 creates the transcript file only when the first turn is
  submitted (2026-10-25).** `SessionStart` already carries `transcript_path`, but
  the file was still absent 4 s after `ready` in every probe and appeared about
  1 s after the first prompt. Elwood used to report each 500 ms poll of that
  missing file as `transcript_read_error (ENOENT)`: 12–13 warnings per session
  with a 4 s idle, and a flood when nested persistence never creates the file.
  The Claude cursor now treats ENOENT as "not created yet" until a stat has
  seen the file. ENOENT after that, and any other read error, still warns.
  Codex never warned here: its shared cursor's `fileSize` already maps ENOENT
  to an empty file. C-CLAUDE-24.
- **That same mapping hid a removed Codex transcript (2026-10-25).** On Codex
  0.164.0, `SessionStart` arrives only with the first submission, and its
  `transcript_path` is a realpath (`/private/var/…/sessions/YYYY/MM/DD/rollout-…jsonl`
  under `CODEX_HOME`); the file exists by the time that turn's `task_complete` is
  committed. Deleting it afterwards made the next poll read size 0, which the
  cursor took for a truncation, so nothing warned and the session's later
  transcript activity was silently gone: no `transcript_read_error` within 10 s
  on `main`. The Codex scan now reads through the shared cursor's existence
  policy, as Claude's does: until a stat has seen the file, ENOENT waits silently;
  after that, every poll, and the final flush, warns with `ENOENT` while the file is
  missing. A file that reappears is read with the
  existing truncation rule. C-CODEX-23.

`elwood sessions` reports `live` from the presence of a `.sock` file in the
session's stable socket home. A connect probe was rejected on purpose: the
bridge treats any connection that closes without a frame as a malformed request
and emits `hookError`/`activity` on the live owner, so presence is the only
side-effect-free signal. C-CLI-21 through C-CLI-24.

## Probe shell startup under concurrency (2026-10-25)

Preflight probes run through the user's interactive login shell (§4.2), so their wall
time is the user's profile plus the CLI. On a 16-CPU host already at load 35–90 with a
typical developer profile (oh-my-zsh with seven plugins, `nvm.sh`, `fnm env`,
`brew shellenv`), measured with Claude Code 2.1.310:

- `claude --version` without a shell took 0.01–0.12 s at 1, 4, 8 and 16 concurrent
  runs. There is no `~/.claude.json` lock, autoupdate check or keychain wait on this
  path. An empty `CLAUDE_CONFIG_DIR` changed nothing, and `zsh -l -i -c true` costs
  the same as the real probe.
- The interactive login shell alone took 2.3–7.6 s for one probe, about 2 s each at 4
  concurrent, about 5 s at 8, 7–19 s at 16 (p50 8–18 s), and 15.5–30.9 s at 32. A
  trace of one startup put about 2.5 s in `nvm.sh`'s command substitutions and 1.2 s
  in `compinit`/`compdef`. Fresh or shared working directories made no difference, so
  this is CPU saturation from fork-heavy startup files, not a shared lock.
- With an empty private `ZDOTDIR`, the same probe took 0.03–0.23 s at 16.

The original 15 s bound covered both phases. 16 concurrent `elwood run`s therefore
failed `claude_start_failed` ("`claude --version` failed", `ETIMEDOUT`) at 17.5–18.9 s:
16 of 16 in one of three fleets at load 68, and 14 of 16 in the original report. The
probe shell now writes `elwood-probe-command-start` on descriptor 3, a fourth pipe the
runner opens, just before the command, then closes it so the command does not inherit it.
Writing it to stderr was the first version; a review pointed out that a profile running
`exec 2>&1` or `exec 2>/dev/null` would hide it. Real zsh with this host's profile, and
zsh with either redirect in a private `ZDOTDIR`, delivered the line on descriptor 3. The
bash check ran `bash --rcfile … -i`, a non-login shell, which keeps descriptor 3 too; macOS's
bash as an interactive login shell does not (next section).
The profile gets a 60 s launch bound and the CLI keeps 15 s from that line (C-PERF-05).
With the stderr version, three 16-run fleets at load 48–74 passed preflight 48 of 48;
the bounds are the same on descriptor 3. The real-shell e2e
uses a private `ZDOTDIR` whose `.zshrc` sleeps 4 s with a 2 s command bound; `main`
fails it with that same `ETIMEDOUT`.

## Probe start line under macOS bash 3.2 (2026-10-25)

macOS's `/bin/bash` 3.2.57, and `/bin/sh`, which is the same bash in sh mode, close every
inherited descriptor above stderr when started with both `-l` and `-i`, even with
`--noprofile --norc`. Pipes a Node parent opened on 3, 9, 10 and 19 were all closed before
the `-c` script ran. `-l` alone or `-i` alone keeps them, and so does Linux's bash 5.2.15
(Debian, in the `node:24` image) as an interactive login shell. zsh 5.9 and ksh 93u+ keep
them; dash keeps 3–9 but cannot name a descriptor of 10 or more, so a higher number is no
fix. With descriptor 3 as the only channel, every probe through those shells failed `login
shell exited with status 0 before starting the probe command` although its command ran,
and so did `elwood`'s agent detection. Any macOS user whose login shell is bash could not
start a session. GitHub's `macos-latest` runner user's shell is bash.

The probe script now tests the write: `if { echo L >&3; } 2>/dev/null; then exec 3>&-;
else echo L; fi`. zsh, ksh, macOS and Debian dash, non-login bash 3.2 and bash 5.2 took
descriptor 3 when it was open and stdout when it was closed, and none printed the failed
redirection's error. The fallback is stdout, not stderr. Under real `bash -l -i` with a
`~/.bash_profile` of `exec 2>/dev/null` or `exec 2>&1`, the line arrived on stdout and the
probe passed. A stderr fallback would have been discarded by the first and moved into
stdout by the second. A profile that hid stdout would hide the command's own output and
fail the probe regardless. The runner removes the line from captured stdout. A profile
that runs `exec 3>&-` itself now falls back too. Only a profile that reopens descriptor 3
onto something else still loses the line. Because stdout is now watched for every probe,
the line ends in a random per-process token: a profile that printed the bare
`elwood-probe-command-start` would otherwise start the command's bound while the profile
was still loading. `tests/unit/probe-closed-descriptor.test.ts` covers this with a
`/bin/sh` stand-in that closes descriptor 3 on every host, and with real `/bin/bash -l -i`
where `/bin/bash` is 3.x. The nine tests of its first version all fail on `main` at
613b3ea5.

## Testing against the real CLIs

- `test:e2e` runs **serially** (`--test-concurrency=1`): Codex config-file
  persistence means parallel test files contaminate each other's `config.toml`.
- The picker/screen parsers are pinned to specific CLI screen layouts (versions
  noted in the fixtures). Layout drift fails loudly rather than silently
  mis-parsing, except where only marker semantics changed.
- Per the testing pyramid in `CLAUDE.md`: anything that interfaces with the real
  CLI SHOULD have a real-CLI e2e. Every fact in this file is one a unit test could
  not have caught.

### Claude under a private `CLAUDE_CONFIG_DIR` (2.1.310, 2026-10-26)

With `CLAUDE_CONFIG_DIR` set, Claude keeps everything there: its global config is
`$CLAUDE_CONFIG_DIR/.claude.json` instead of `~/.claude.json`, and settings,
`projects/` transcripts, history and backups sit beside it. `claude auth status`
reports both paths (`configDirectory`, `projectsDirectory`). Without the variable,
every directory Claude runs in gets an entry in `~/.claude.json` and a transcript
folder under `~/.claude/projects/`, so each real-Claude e2e scratch project used
to leave both behind.

An empty config dir is logged out (`loggedIn: false`): Claude does not read the
default `Claude Code-credentials` keychain item for it. It does read a
`$CLAUDE_CONFIG_DIR/.credentials.json` holding the keychain item's JSON. A copy with
`refreshToken` and `refreshTokenExpiresAt` removed logs in (`authMethod:
"claude.ai"`), creates no new keychain item, and cannot refresh, so it can never
rotate the user's own refresh token. It works until the access token's `expiresAt`,
which is why `tests/e2e/claude-home.ts` copies it afresh in each process.

An `ANTHROPIC_API_KEY` in the environment logs any config dir in on its own
(`authMethod: "api_key"`), so check a login with it unset. In the TUI, whether that
key is used is the global config's `customApiKeyResponses`, which the e2e copy keeps.

The private dir carries none of the user's `settings.json`, so it shows what a fresh
install does: the bypass-permissions dialog appears unless
`skipDangerousModePermissionPrompt` is set (see above), and the footer shows Claude's
default permission mode. C-E2E-23.

### A rate-limited Codex turn stays running for minutes (2026-10-25)

Codex 0.164.0 retries a `429 Too Many Requests` after the server's retry delay. In
Codex's own log (`~/.codex/logs_2.sqlite`, target `codex_core::responses_retry`)
the delay for four e2e turns on one account's default model was 110 to 509 s. All
four retries were scheduled for the same instant, the end of a usage window. While
it waits, Codex paints
`• Reconnecting... 1/5 (44s • esc to interrupt)` over
`└ Exceeded retry limit, last status: 429 Too Many Requests`. The rollout ends at
the user message with no reply, and no `Stop` hook fires. Elwood correctly stays
`running`, because the turn has not ended. A real-turn e2e that inherits the
developer's `~/.codex` shares that model's limit with every Codex session on the
account, so it can wait out a backoff no test timeout covers. A test avoids this by
pinning a private `CODEX_HOME` and a small model. `tests/e2e/resume-ready-codex.e2e.ts`
does, and bounds its readiness, turn and submission waits so a stuck step fails with
its label and the screen.

A private home whose `config.toml` points
`model_provider` at a local `[model_providers.<id>]` with `base_url =
"http://127.0.0.1:<port>/v1"` and `wire_api = "responses"` reproduces this
without quota. That provider answers every request with 429 and `retry-after: 300`.
Codex still lists models from it before the first turn. C-API-28.

### Concurrent cold starts race Codex's state migrations (2026-10-25)

Codex 0.164.0 creates and migrates its SQLite state under `CODEX_HOME` at launch
(61 migrations in `state_5.sqlite`, 2 in `goals_1.sqlite`), and nothing serializes
those migrations across processes. When two Codex processes start together in a home
whose databases are not yet migrated, both try to apply the same migration. The loser
exits 1 with `Codex couldn't start because its local database appears to be damaged`,
and the cause names the collision, such as `table thread_goals already exists` or
`duplicate column name`. Six different migrations collided across the runs below. The
exit landed 2 to 10 s after spawn. In every Elwood run that was after `startCodex` had
resolved, so Elwood reported `running` → `exited` (`terminal_exited`) and the session
never reached `ready`.

C-CODEX-14's e2e started its two sessions with `Promise.all` in a fresh sandbox. The
same start lost a session in 4 of 5 probes and in 5 of 6 e2e runs. The test's readiness
poll then ran out its full minute, and the surviving session, which `Promise.all`
dropped, kept the test file running. Replaying Elwood's exact launch command through a
bare node-pty, with no Elwood code, crashed one of the two in 3 of 4 runs. One launch
alone never crashed. Bare pairs with only `--sandbox`, `--ask-for-approval`, and `--cd`
never crashed in 16 runs. Adding `-c model_reasoning_effort="low"` alone or
`--dangerously-bypass-hook-trust` alone crashed 3 of 3, and `-c features.hooks=true`
alone crashed 0 of 3. The runs do not show why the bare pairs escaped, so treat any
pair of simultaneous launches as exposed.

A single launch at load 50 finished every migration about 1.5 s after spawn, as its
composer painted. The composer does not prove migration is done: a launch killed one
second after its composer appeared left migrations for the next pair, which raced in 1
of 4 runs. The e2e now starts the second session after the first reports `ready`, which
on a cold start is the 10 s deadline from the first frame. The concurrency it tests is
the model switch.

Production homes already hold migrated databases. The exposure is the first launch of
a Codex release that adds a migration, if several sessions start at that moment.

### Codex commentary and final-answer phases (2026-10-20)

The reported completed `response_item` fixture retains assistant text in an
array-form `output_text` block with `phase: "commentary"`. The previous summarizer
discarded that phase. It now produces `assistant_progress`; final answers retain
`assistant_message`. Explicit non-final legacy `agent_message` mirrors remain raw
observations without normalized text, avoiding false final replies and duplicate
progress. Tests exercise mirrors before and after canonical response items, as
well as repeated genuine canonical updates.

An isolated real Codex 0.159.2 / `gpt-6-luna` low-effort turn passed
`tests/e2e/codex-commentary.e2e.ts`: one progress event preceded one final event,
progress observed `running`, the turn ended `ready`, and ergonomic `send()`
returned only final text. Exactly one paste and Enter were delivered, with zero
tools. The test uses a private Codex home and empty project, removes that home,
and checks the parent environment and Codex auth/config/hook file fingerprints.
Run explicitly with `ELWOOD_NATIVE_COMMENTARY_PROOF=1`; it consumes one small
valid-model turn. This pinned-version proof does not establish every future CLI
layout or guarantee that arbitrary prompts will cause a model to send commentary.

### Model-picker dispatch and post-cancel composer (2026-09-19)

A serial native PTY probe on Codex 0.155.1 and Claude Code 2.1.278 typed
`/model`, waited 300 ms, then sent Enter. Neither CLI displayed its model picker
before Enter; both displayed it afterward. Model test drivers must therefore wait
for the command's submitting Enter before painting the picker. No model prompt was
submitted in this probe.

Codex returned to its known `Ask Codex to do anything` composer and model/effort
footer after Escape; automated `listModels` then returned five rows. Claude kept
`❯ /model` and `Kept model as …` in the transcript above its final fenced composer.
Its idle footer read `-- INSERT -- ⏵⏵ auto mode on (shift+tab to cycle) · ← for
agents`. A whole-screen clearance predicate that rejects every earlier caret
therefore rejects this genuine post-picker idle frame. Model clearance must use
the last composer, its enclosing rules, and its native footer; a bare caret or a
partial model dialog is insufficient. The sanitized Claude frame is retained in
`tests/fixtures/claude-2.1.278/model-cancelled.txt`. With this recognition fix,
Claude also completed automated `listModels` and returned five rows (C-API-55).

### Idle CLIs do not repaint (2026-10-25)

A probe started real sessions through Elwood, waited for `ready` plus 3 s, and then
counted PTY output chunks while the session sat idle. Codex 0.164.0 emitted none in
15 s idle, and none in the 10 s after `listModels` opened and cancelled its picker.
Claude Code 2.1.310 emitted one chunk in each window. Clearing a model-dialog hold
therefore cannot wait for a run of new frames, because on Codex none arrive. The
evidence has to be the same completed frame read over time. Readings count at
least 40 ms apart, so neither bunched readings nor a fast burst of repaints can
release a hold early (C-API-55).


### Cursor provenance for Codex trust clearance

Startup-only probes on 2026-09-19 checked Codex 0.142.5 and 0.155.1 at 100×30,
without submitting a model prompt. Both hide the cursor with DEC private mode 25
on the directory-trust and `/model` dialogs, leaving its coordinates on a footer.
Both show the cursor at column 2 on the native placeholder row after trust and
after dismissing the picker. Codex 0.155.1 retains this evidence at 100×6.
The 0.142.5 narrow resize leaves malformed chrome, so that frame is not used as a
positive fixture. Inspect cursor mode and coordinates together with the same
completed rendered text and title: an old composer or footer can remain during a
dialog repaint, and a transcript can contain identical caret/option text.

### Cancelled native composer drafts (2026-09-20)

Claude Code 2.1.278 and codex-cli 0.155.1 both cleared a staged `[Image #1]` chip
and text draft when production cancellation cleanup sent Ctrl+U followed by Ctrl+K
through the real PTY. `tests/e2e/composer-cleanup.e2e.ts` waits for idle readiness,
observes the image and text, then cancels before Enter; it rejects any submitting
Enter and observes no `UserPromptSubmit` hook, so no model turn runs. Disabling
only the production clear write made both tests retain the image and text and fail.
This verifies an automation-owned idle composer, not cleanup across caller edits
or blocking dialogs. Codex clipboard text is restored after attachment.


Native startup protocol replies also emit xterm `onData`. The actual-session
image-cancellation proof exposed this on both adapters: treating those replies as
caller edits revoked cleanup before its first staged image. A real terminal's
cursor-position query (`CSI 6 n`) reproduces the revocation without any caller
input. Ownership now tracks `xterm.input` invocations; parser-generated replies
preserve authority, while caller keys still revoke it. Startup trust writers also
use that automation scope: both actual-session trust fixtures showed that writing
outside it revoked cleanup before the first caller submission.

The actual-session image queue also exposed a consumption race: writing the clear
keys did not establish that Claude had removed the staged image before successor
attachment. Cleanup therefore waits for a fresh completed empty native frame. A
bounded Claude probe then found a cleared frame with a visible input cursor at
column two, enclosing rules, and a version banner: existing whole-frame live
clearance accepted it, while the post-model-picker suffix predicate rejected it.
Cleanup accepts either existing positive Claude clearance path, preserving the
same completed-render and cursor checks. The suffix path remains useful when
earlier conversation carets prevent whole-frame clearance.


### Capitalized Codex model footer (2026-09-23)

Codex 0.156.1 renders `GPT-6-Astra default` in the native footer, followed by
its working directory and a right-aligned warning count. A 189×48 capture after
staged-draft cleanup showed the empty `Ask Codex to do anything` placeholder with
the input cursor at column 2, row 11 (zero-based), but the lowercase-only `gpt-`
footer pattern rejected the completed native frame. Cleanup consequently reported
`Could not clear the staged composer draft` after the CLI had already cleared it.
The model prefix now accepts the captured `GPT-` spelling alongside `gpt-`;
placeholder, footer layout, live cursor and blocking-overlay checks remain required.
The captured nonempty rows are retained in
`tests/fixtures/codex-0.156.1/cleared-composer.txt`; the regression replays them
at their original viewport size, with temporary paths replaced by a stable `CAPTURE`
placeholder. C-API-56, C-TRUST-01, PRD §5.4.

### Native Codex updater layout (2026-09-23)

An authenticated Codex 0.155.1 binary, copied into an isolated `CODEX_HOME`
standalone-release layout with fresh cached update metadata naming 0.156.1,
rendered the actual updater without selecting any menu item. Native PTY resize
captured the full menu at 100×30, banner plus the clipped first action at 100×6,
banner only at 100×3, and the first safe choice at 100×8. The fixtures in
`tests/fixtures/codex-0.155.1/update-*.txt` preserve the rendered text.

The banner begins with `✨` and a thin space. A release-notes link precedes the
options. The `Update now` install command wraps onto an indented continuation
row; `Press enter to continue` follows the option block. The parser accepts those
observed rows while rejecting numbered scrollback before the banner and unknown
text after the choices. Wrapped command fragments must form a prefix of the
captured `sh -c 'curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh'`
action. Arbitrary indented replacement text is not a command continuation or safe choice.

These captures prove native renderer layout under controlled cached metadata,
not an update execution or a genuine bannerless repaint. The banner remained
visible in every captured resize. Adversarial replacement frames and shell-PTY
proofs are separate constructed evidence; these fixtures alone do not prove
queued-input suppression through a live Elwood session.

A controlled real-session probe passed on 2026-09-23: one test, one pass, no skips. It verified the pinned binary's
version and login status, then started Elwood with normal automatic skip handling
and a queued caller message. At 100×6 and 100×3, Elwood stayed `blocked` and emitted
`codex-update-prompt` attention. Neither automation nor the queued message attempted
an application write; the queue rejected on shutdown. The PTY interceptor recorded
attempts before rejecting them, so it could not hide an incorrect selection. Only
exact native terminal protocol replies were forwarded. `autoupdate: false`
disabled installation, not startup-menu skipping. The temporary binary, config,
version metadata, and credential copy were removed after teardown. This proves
these narrow native layouts under controlled version metadata; it does not prove
a bannerless continuation, run an updater, or submit a model turn.

### Native updater resize to a bannerless empty viewport (2026-10-01)

A fresh isolated Codex 0.155.1 probe used the actual pinned standalone binary and
private authenticated `CODEX_HOME`, with cached metadata naming 0.156.1. With
normal startup-menu skipping enabled and one caller message queued, resizing
100×6 → 100×2 → 100×1 → 100×3 → 100×6 produced a genuinely empty viewport at one
row. The two-row frame still contained the banner. The empty repaint remained
`blocked`, emitted `codex-unidentified-dialog` attention, held the caller, and
attempted zero application writes. Returning to three and six rows restored the
banner and retained the hold. Shutdown rejected the queued message.

The run passed one test with no skips. Application writes were counted before
being rejected by the interceptor; only exact terminal protocol replies reached
the PTY. No updater action or model prompt was delivered, and the private binary,
metadata and credential copy were removed afterward. This proves a genuine
bannerless **empty** repaint, not a bannerless numbered-choice layout. The initial
six-row layout had only the clipped update action, so that narrow phase alone
establishes no live safe-choice selection.

The final proof also launches a second isolated session without a queued caller,
then resizes its real updater from 100×6 to 100×30. Before every application write,
the interceptor checks the current rendered first-party banner and parsed `2. Skip`
choice; only the exact digit `2` is permitted. The measured run attempted and
delivered exactly one `2`, reached `ready`, then closed without a model prompt.
The combined test passed 1/1 with no skips (8.28 seconds); the narrow phase still
had zero application attempts. The negative session is killed before this phase,
so its held caller cannot become a model submission when the menu clears.

`tests/fixtures/codex-0.155.1/update-resize-100x1.json` preserves the actual frames.
The opt-in `codex-native-update.e2e.ts` proof is repeatable with
`ELWOOD_NATIVE_UPDATE_PROOF=1`; it verifies the pinned binary and login state before
launch and never installs over the user's CLI. C-CODEX-12.

### Empty input while a turn is active (2026-09-23)

The retained Claude 2.1.281 `working.txt` and `working-empty-input.json` captures
contain `⚠ Your login expires in 1 day · run /login to renew` in the welcome
region and the same notice without `⚠` below the native composer. A user report
on 2.1.305 (2026-10-20) shows the same welcome wording with `3 days`. These
observations underpin the `login_expiring` warning (C-CLAUDE-23); they are advance
renewal notices, not the lapsed-authentication screens used by `login_expired`.
No `/login` was driven to collect this evidence.

Native captures show that empty input and idle-turn clearance are different facts.
Codex 0.156.1 kept its visible cursor at column 2 on `Ask Codex to do anything`
while its working title and interrupt status were active. The bounded probe used
an invalid model and reached rejection without model quota. Its model-only status
line also carried a right-aligned `⚠ 3 warnings · f2 to view` badge.

Claude Code 2.1.281 kept a visible column-2 cursor on its empty fenced input while
`Wandering… (0s)` and the `◐ Claude Code` title were active. A single synthetic
`Reply exactly OK. Do not use tools.` request in an isolated workspace supplied
this capture; the request later reached a usage limit, so it proves active input
geometry, not a successful answer. The native manual-mode footer included the
token count and a login-expiry notice. No further valid-model requests were made.

The sanitized `working-empty-input.json` fixtures retain these actual completed
frames and cursor coordinates. Empty-input observers may use this geometry to
confirm a consumed draft during work. They do not release trust, model-picker, or
cleanup holds: those retain their stricter idle contract. Replay callers must
also retain their existing dialog-blocking check and require a fresh frame after
submission; an old empty frame does not prove acceptance.

The Claude observer also preserves the existing version-banner/fenced-input
alternative and the documented 2.1.268 non-Vim bypass-permissions footer.
Those compatibility cases are constructed regressions, not new working captures.

## Native submission hooks end recovery (2026-09-24)

`tests/e2e/paste-recovery.e2e.ts` passed against Claude Code 2.1.281 and
codex-cli 0.156.1: 2 tests, 2 passes, 0 failures, 0 skips, covering cold and
resumed sessions for each adapter. Every phase physically delivered one Enter,
emitted one `UserPromptSubmit`, and attempted no recovery Enter after native
`user_message` activity during a further six-second observation.

Codex resume did attempt a recovery Enter before its hook arrived: first Enter
at 151 ms, retry at 1155 ms, native activity at 1317 ms. The test counted that
retry and intercepted it before delivery. This proves the hook-only guarantee;
it does not prove safety in the interval before the hook, or isolate native
working evidence. The other three phases each attempted only the first Enter.

Both CLIs rejected a nonexistent model before quota consumption. Since public
resume options omit model, the test appended that same invalid native `--model`
at the PTY launch seam. Native hooks, readiness, and input queues remained real.
All processes and temporary credential copies were cleaned up. These observations
do not establish successful model output or correlation of a hook to a prompt.

## Live staged text and ambiguous working frames (2026-09-24)

The 2026-09-24 no-submission captures of Claude Code 2.1.281 and
Codex 0.156.1 show the actual cursor inside collapsed or wrapped drafts. Codex
continuations use two-space indentation and may cross a nonzero buffer base.
Claude collapsed text uses the exact “paste again to expand” footer, with the
separate `◐ medium · /effort` row observed again in the fresh recovery probe; Ctrl+Y
can remain visible from an earlier draft. Those captures did not establish that
Ctrl-U/K removed all earlier text, and are not a model-turn acceptance proof.
Committed fixtures preserve geometry while replacing account/quota details and
temporary workspace names.

Actual session/PTY tests distinguish the current cursor-owned composer from
identical transcript text. Startup or resume replay and accepted native work can
produce indistinguishable working frames before readiness. Recovery therefore
withholds Enter during work without permanently inferring acceptance. A fresh
positive empty input frame or native user-message activity ends that submission’s
recovery; otherwise a later verified idle draft remains eligible within the
four-observation/two-Enter bound. This is a conservative policy tested with
controlled frames, not a newly observed native correlation guarantee.

A fresh bounded recovery probe on these same CLI versions passed for both
adapters: an 18-line prompt remained staged, and the actual PTY writer attempted
exactly the first Enter plus two recovery Enters, near 150/1150/2150 ms. All three
Enters were intercepted before delivery; neither CLI emitted UserPromptSubmit,
and neither ran a model turn. This proves native staged geometry and retry
bounds, not acceptance or post-acceptance behavior. The temporary Codex auth
copy was removed after teardown.


## Cached image recovery frames (2026-10-01)

The existing captured image-chip and staged-text layouts establish live composer
geometry, not whether an Enter was accepted after the capture. A completed idle
frame can remain cached until a later native repaint; a second Enter must not be
authorized from that pre-attempt frame. Recovery now captures the render revision
before each physical Enter attempt and requires later completed output plus the
adapter's live idle-composer check. Resizing or scrolling changes snapshot geometry
without establishing this output ordering. Native user-message activity retains
its independent, permanent revocation of recovery.

The attachment-to-submission regressions use the real adapters and terminal parser,
with controlled PTY output and a stubbed Codex platform clipboard. They retain the
native Claude effort footer and distinguish fresh attached chips from history,
hidden/working frames, and unchanged pre-Enter chips. This is deterministic ordering
evidence, not a new native CLI acceptance measurement.

## Codex whitespace-only staged input (2026-10-01)

Private copied Codex 0.159.2, auth and config rendered a bracketed paste of two
spaces, a tab and a space as an apparently empty `›`. The completed 140×35 frame
was ready with visible cursor at zero-based (6,31): trimming text cannot prove
consumption. Fixture: `tests/fixtures/codex-0.159.2/whitespace-only-input.json`.
Updates were disabled and the model nonexistent. Exactly one paste and two
protocol replies occurred, with no Enter, UPS, clipboard operation or model turn.
Private home cleanup and unchanged parent environment passed. This proves geometry,
not acceptance. Controlled replay combines it with an older captured empty frame;
image tests exercise adapter options with stubbed clipboard. No native Claude
whitespace capture is claimed.

## Codex 0.159.2 native acceptance ordering

A private-home Node 24.7.0 cold/resume probe used
`gpt-elwood-nonexistent-acceptance-probe`, one Enter/UPS per phase and a one-second
handler hold. The real generated bridge received its 38-byte response only after
return (cold 1.353ms, resume 1.391ms), verifying half-close transport without a
successful model/quota turn. Parent environment and global config were unchanged.
Bounded pre-Enter discovery found no cold candidate, not proof no file existed.
Resume used the persisted native ID with cold path memory cleared. Both UPS events
had native task/turn-context metadata, but the new user record appeared only after
ACK, absent at ingress and during the hold. Waiting for that record before ACK
would deadlock the work ACK unblocks. This is ordering evidence, not a filesystem
authority requirement for the authenticated per-launch hook channel.

Official `rust-v0.159.2` commit `ff6aec96948b70d94983af2641a6b67c94faeff5` explains it:
`core/src/hook_runtime.rs::inspect_pending_input` supplies active
`turn_context.sub_id` and awaits UPS; `core/src/session/turn.rs::run_hooks_and_record_inputs`
records afterward. SessionStart hooks run earlier. Steering shares the active
context, so Enter need not create a new turn ID. `core/src/tasks/regular.rs` runs
input hooks on cancelled startup too: cancellation cannot rule out delayed prior
UPS. Successors must retain predecessor boundaries, not claim unfamiliar IDs from
matching text alone.

Opt-in `tests/e2e/codex-native-response.e2e.ts` passed on Codex 0.159.2 / Node 24.7.0,
`gpt-6-luna`, low effort: two valid model turns in private home/empty workspace,
cold `CodexSession.send` then `HeadlessCliSession.stream` using persisted Elwood
record/native resume ID. Each returned its distinct exact synthetic token; resume
excluded the old token. Each had one paste/Enter/UPS/Stop and zero tools. Private
home removal and unchanged parent environment passed. This pinned-version response
isolation proof is separate from bogus-model ACK ordering.

The pinned response fixture isolates both probe and PTY shell startup with a
child-only `ZDOTDIR` pointing at its private home. An inherited interactive zsh
profile timed out before `codex --version` at 15 seconds; the same pinned binary
with an empty private profile directory returned its version in 52 ms. This
preflight failure submitted no model turn. Parent environment values stay intact.

### Claude named-session composer rule (2026-10-24)

`claude --name` (Elwood's `name` option; Coal Harbor names every agent) insets the
name into the composer's top rule on Claude Code 2.1.310: `──── Question Asker ─`.
The rule below the composer stays plain, and the terminal title becomes
`✳ Question Asker` instead of `✳ Claude Code`. Composer recognition required plain
rules on both sides, so trust clearance and empty-input observation never matched a
named session. In an untrusted folder, autotrust answered the trust prompt but the
session stayed `blocked` on the idle composer; in a trusted folder it reached `ready`
through hooks and hid the gap. The top rule may now carry one inset label
(`src/claude/composer/border.ts`). See `tests/fixtures/claude-2.1.310/`.

### Claude permission-mode footers (2026-10-25)

Startup-only captures from Claude Code 2.1.310 launched with each
`--permission-mode`, with no model prompt sent. The footer is the row directly
under the composer's bottom rule. With the developer's settings
(`editorMode: "vim"`, `verbose: true`):

```
-- INSERT -- ⏸ manual mode on · ← for agents                        0 tokens
-- INSERT -- ⏸ plan mode on (shift+tab to cycle) · ← for agents     0 tokens
-- INSERT -- ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents  0 tokens
-- INSERT -- ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents    0 tokens
-- INSERT -- ⏵⏵ don't ask on (shift+tab to cycle) · ← for agents    0 tokens
-- INSERT -- ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents  0 tokens
```

The effort level (`● high · /effort`) sits on the next row. With
`editorMode: "normal"` and `verbose: false` (passed through `--settings`, never
written to user config) there is no `-- INSERT --` and no token count, and the
effort level moves to the footer's right edge:
`⏸ manual mode on · ? for shortcuts · ← for agents   ● high · /effort`. Only
manual mode lacks `(shift+tab to cycle)`, and in this layout only manual mode
shows `? for shortcuts`. A `default` launch renders `manual mode`. Vim normal mode,
after an Escape at the idle composer, drops the `-- INSERT --` prefix. Each
effort level has its own glyph: `○ low`, `◐ medium`, `● high`, `◉ xhigh`,
`◈ max`. The captures only show `0 tokens`. The binary formats counts with
`Intl.NumberFormat` compact notation, then lowercases them: `999`, `1.0k` (or
`1k` where it strips `.0`), `12.3k`, `2.1m`. Counts are never digit-grouped.

Some pieces are transient. Release notes embedded in the 2.1.310 binary say
`← for agents` hides 10 seconds after a session opens. In the captures it was still present at 13 s
and gone by 27 s. Late frames also lost the effort level: no effort row in the
vim layout, an empty right edge in the plain one.

Elwood accepted only the 2.1.278 auto and don't-ask footers with the agents hint
and no right edge, plus the 2.1.305 manual footer. On 2.1.310 only the late
plain manual footer, identical to 2.1.305's, still matched. Trust clearance then depended on the version banner, which
scrolls out of the viewport in a long session. Model-picker hold release never
saw the banner at all, because it reads only the last composer and the rows
beneath it. Empty-input observation rejected every 2.1.310 effort row. The shared
grammar is `src/claude/composer/footer.ts`, and trust clearance requires the
footer directly under the bottom rule, so a quoted footer cannot pass for chrome.
Empty-input observation requires the same row. None of the 159 composer frames
captured on 2.1.310, and none in the 2.1.278 to 2.1.305 fixtures, has a blank row
between the bottom rule and the footer. Overflow rows and the login-renewal notice
only ever follow the footer.
Sanitized 100x8 bannerless frames for every mode are in
`tests/fixtures/claude-2.1.310/mode-footers/`. `tests/e2e/permission-footer-claude.e2e.ts`
checks a real bypass-permissions session. C-TRUST-01, C-API-55, C-API-56.

Narrow terminals are not covered. Below roughly 64 to 90 columns, depending on the
mode and layout, Claude cuts the footer mid-hint, sometimes with an ellipsis:
`⏵⏵ bypass permissions on (shift+tab to`, `(shift+tab to cycle) · ← fo…`,
or just `⏵⏵ bypass permissions`. It also moves the token count and effort level
onto their own rows. A cut footer does not prove the composer, so the hold stays
until the terminal is widened. The hand-opened 2.1.310 picker itself
(`● High effort ←/→ to adjust`, a `↓ 8.` scroll marker, `… +5 models`) falls
outside the model-dialog grammar on `main` at the time of writing, so that
grammar is the remaining gap before a foreign hold engages on it.

## Claude question editor captures (2026-10-20)

Claude Code 2.1.305 accepts a single question on Enter. Grouped questions advance
through tabs and end on a separate Review your answers / Submit answers page.
Multi-select uses checkbox rows, Space to toggle, and a per-question Submit row.

The highlighted Type something row is already an editor: paste before Enter.
An empty Enter there declines the request. A two-line bracketed paste preserved
its newline. Choice rows start at column zero with a highlight or space, followed
by one space. Other continuations are indented five spaces, so their numbered
lists are text, not additional choices. The checkbox Submit row also uses five
columns, but occurs only in the multi-select layout.

A native checkbox Submit highlight can have a hidden terminal cursor parked at
column zero on the viewport's bottom blank row. A multiline Other answer places
the visible cursor on its indented continuation. Neither necessarily sits on
the highlighted option glyph. The captures used private configuration and
authentication copies with synthetic prompts; see
`tests/fixtures/claude-2.1.305/questions/`.

### Claude 2.1.310 question chip and named-session border (2026-10-24)

Claude Code 2.1.310 renders a single question's header chip as ` ☐ Test pick `:
the highlight's right padding is a written trailing space, so the terminal row
keeps it. 2.1.305 rendered ` ☐ Note` with no padding. Exact equality on the tab
row therefore rejected every single-question panel on 2.1.310, and Elwood never
raised the request even though the native dialog was on screen. The pinned
2.1.305 proof could not see it. Tab matching now ignores trailing whitespace
only; the leading space and the header text still have to match exactly.

A session launched with `--name` (Coal Harbor names every agent) draws its label
into the prompt box's bottom border — `──── Question Asker ─` — and that border
stays one row under the questionnaire footer. The rule above the header chip
stays plain. The questionnaire grammar used to require nothing but blank rows
after the footer, so it rejected every question in a named session. It now
accepts exactly one labelled border there and still rejects anything else. See
`tests/fixtures/claude-2.1.310/questions/`.

### Claude question dialogs and manual composer (2026-10-20)

Claude Code 2.1.305 renders `AskUserQuestion` as a fenced questionnaire with
checkbox headers, numbered choices, and a selected `❯` row. That caret belongs
to the dialog, so the captured questionnaire is a blocking screen fact. The
retained question and review frames are under
`tests/fixtures/claude-2.1.305/questions/`.

After native submission the captured `accepted-manual-composer.json` contains
`⏸ manual mode on · ? for shortcuts` below the fenced empty composer. Earlier
question prompts remain above it. The footer is valid native composer chrome;
clearance still requires the current visible cursor at column two on the empty
input row. A hook candidate may arrive while the previous composer is still
visible, so that old frame cannot retire it before its matching questionnaire has
appeared. Matching uses the live panel’s tabs and prompt, rather than earlier
question text or cancellation notices retained in history.

These captures establish the questionnaire and manual-footer additions on
2.1.305. They do not reverify every screen-table pattern from earlier versions.

The private adapter/controller tests retain native input ownership when a
composer repaint precedes the matching completion hook. Successful submissions
keep their request pending; a post-write abort retires the public ID while the
native hold remains until matching completion, replacement or turn end. A
predecessor review panel cannot publish a newly observed successor.

Live sessions connect this adapter to the session-owned question controller,
completed terminal renders, hook routing and the ordinary-input gate. Claude's
hook-decision gate resolves the exact caller hook outcome before publishing a
request; direct answers and denials withdraw automation while retaining native
ownership until matching completion, replacement or turn end. The captured frames
establish the native layouts; the capture-specific version and screen-pattern
limitations above still apply.

Structured answers use the session-owned transaction lane; request listing
bypasses an active ergonomic turn. After uncertain dispatch, both physical write
settlement and matching native closure are required before ordinary input resumes,
regardless of their order. The live screen-fact rule also holds input while the
questionnaire is visible.


A final Enter rejected before physical dispatch, including by a current-frame or
abort guard, does not count as submission. Once dispatch begins, a rejection or
abort leaves delivery uncertain: the native identity and input hold survive an
empty composer until matching native completion, replacement or turn end.
A semantic replacement of a known questionnaire must show matching new choices
before a retained composer can retire it.

### Codex question panels, work pulses, and Plan footer (2026-10-20)

Codex 0.163.0's native queued-question UI can coexist with a working status
that pulses between `•` and `◦`. Both glyphs retain the elapsed-time and
`esc to interrupt` grammar; the lighter pulse does not end the running turn.
A blocking question panel ends with its own navigation/submission footer and
must hold ordinary input even though its selected option also uses `›`.
The captured queued choice panel hides the native cursor and can leave its
coordinates at the end of the working row above the panel. That position is
valid only with hidden cursor, exact working-row geometry, and blank intervening
rows; a visible or unrelated cursor does not establish panel ownership.

After a Plan mode question completes, the native model footer includes the exact
right-aligned `Plan mode (⇧tab to cycle)` suffix. That suffix preserves empty
composer evidence alongside the existing model/footer grammar, current visible
cursor, and overlay checks.

The native `async-editor-first.txt` queued editor and `blocking-modal-first.txt`
modal captures retain their exact header and terminal footer. The collapsed
`? 1 question` badge is not an open editor and does not itself block ordinary input.

These captures establish the layouts in
`tests/fixtures/codex-0.163.0/questions/`; they do not reverify all earlier
Codex trust and update dialogs.

### Native Codex editor provenance and clipped drafts (2026-10-21)

Two isolated Codex 0.163.0 captures distinguish an empty placeholder from a
literal answer with the same text. In queued input, `Type your answer` starts
with a dimmed cursor cell at column 2; typing that literal leaves a nondimmed
cursor after it at column 18. Modal notes render `  › Add notes` in both states,
with the empty dimmed cursor at column 4 and the typed cursor at column 13.
Private question frames retain the actual cursor-cell dimming and the cell-derived
prefix from the same completed render. Public terminal snapshots keep their shape.

The native editor manually wraps text without setting xterm `isWrapped`, clips
long prefixes even at 140×45, and omits visible glyphs for interior trailing
spaces that still survive submission. Both queued and modal answers trim outer
whitespace on submission: a synthetic 764-character paste was accepted as its
760-character `trim()` result. A continuation containing an indented `›` remains
answer text; it cannot replace the native notes start after the option block.

The snapshots, source hashes, expected inputs, and native acceptance evidence are
in `tests/fixtures/codex-0.163.0/questions/editor/`. A viewport alone cannot establish
complete logical equality of multirow or clipped drafts. Cursor-cell style and a
physical row prefix are partial evidence, so they must not confirm unshown answer
text. Full-answer verification must bind an owned paste to the native accepted
payload rather than infer missing text from the screen.

## Native interactive question records (2026-10-20)

Claude Code 2.1.305 exposes structured `AskUserQuestion` input in PreToolUse and
PermissionRequest hooks. PermissionRequest can omit the native tool-use ID
(`tool_use_id`). Direct hook answers may bypass the terminal editor. PostToolUse
carries the accepted answers for the entire tool request. See
[Claude question editor captures](#claude-question-editor-captures-2026-10-20)
for the captured editor, navigation and submission behavior.

Codex 0.163.0 Plan-mode
`request_user_input` groups questions in a modal and returns one function output
with all answers. Every question needs nonempty options; a free-text-only tool
call was rejected before any editor appeared. None of the above plus notes
provides free text. `request_user_input_async` immediately returns accepted:true,
then exposes independently answerable queued questions while work continues.
Shift+Left opens the editor. Answering one leaves the others available, with a
committed `send_user_message_question_reply` envelope identifying the exact
question. The editor advances to a remaining question and stays expanded, so
Elwood remains `blocked` even while the working row continues. This status does
not complete the original `send()` turn. Ordinary composer input is not an
equivalent answer route. Consecutive answer echoes can contain indented `›`
inside multiline text before the final assistant response. Only that bounded
response makes them transcript history for empty-composer recognition; an
uncompleted user echo or numbered native option block still holds input.

Async question AgentMessage records can say phase:final_answer while work is
still running. They are question metadata, not a final assistant reply. The
paginated item_completed mirror uses type AgentMessage. Deduplicate these mirrors
against the stable tool call. The native question ID encodes the call ID and
question index. Ctrl+] locally skips the focused async question without an answer
record; Esc from its editor can merely collapse it. Do not treat every Esc as a
turn interruption.

Queued editors after the first use `⇧→ prev question`; only the first uses
`⇧→ main prompt`. Keep this distinction in captured and scripted navigation
frames. If a local skip and Esc collapse coalesce into one output render, the
smaller badge does not identify the removed question. Preserve the prior focused
editor count until a matching remaining editor confirms that removal.
