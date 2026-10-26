# Changelog

All notable **consumer-facing** changes to Elwood are recorded here: new or
changed public API, session/lifecycle behavior, activity/event shapes, and bug
fixes a host application would notice. Internal refactors, test-only changes,
and doc tweaks are omitted. The format follows
[Keep a Changelog](https://keepachangelog.com). Changes accumulate under
**Unreleased** and move into a versioned section for each release.

Observable behavior is specified in `prd/`; the conformance criteria that
back each entry are listed in `prd/14-conformance.md`.

## [Unreleased]

- Elwood now runs at most 8 login-shell probes (`--version`, `--help`, `update`,
  and PATH lookups) at once in a process; more wait their turn, and a probe's time
  bounds start when it runs. Each probe starts an interactive login shell, and with
  a heavy shell profile many at once slowed every one of them.

- A `claude --version` or `codex --version` check that fails (it exits nonzero,
  times out, or cannot start) no longer fails every later start of that adapter
  in the process. Elwood kept the failed result and replayed it as the same
  `claude_start_failed` or `codex_start_failed`; a later start now runs the
  check again. Concurrent starts still share one check and its outcome.
- `teardown_failed` now keeps what each failed step reported. Alongside
  `details.causes` (the messages), `details.failures` lists each failed step,
  with its `code` and `details` when it was a typed Elwood error, so a failed
  reap's `termination_failed` errno is no longer lost. The CLI's cleanup
  diagnostic names those typed causes by code, plus their valid errno and reap
  errno tokens when present, for example `Cleanup failed (termination_failed
  EPERM).`, instead of only `Cleanup failed.`; it still never prints their
  messages or paths. In text mode, a cleanup failure behind a timeout,
  interruption, or other primary failure now gets its own stderr line after the
  primary error, in `run`, `models`, and combined `models`; before, text mode
  printed only the primary error.

- A `stop()` or `kill()` whose termination fails now still cleans up the
  session's runtime (its hook bridge and terminal renderer, and Codex's transcript
  watcher). Before, a PTY that could not be signaled, did not exit, or could not be
  reaped skipped that cleanup, and so did every retry while the reap kept failing,
  until a `teardown()`. The call still rejects with the same `termination_failed`;
  if cleanup fails as well, its message is in `details.cleanupError`. `close()`
  keeps those messages too, as `cleanupError` and `killCleanupError`.

- Raw input a host sends from inside one of Elwood's own writes, such as from an
  `xterm.onData` listener reacting to Elwood's keys, now revokes Elwood's
  automation like any other raw input. Before, it counted as part of Elwood's
  write, so a model-picker operation, composer cleanup, question answer, or
  startup-prompt answer kept writing after the caller's keys.

- A Claude session's runtime cleanup now finishes its transcript watcher, as
  Codex's already did. Before, only the Claude process's exit finished it, so
  after a `stop()`, `kill()`, or `teardown()` that could not terminate the PTY,
  the session kept polling the transcript and emitting its activity. Claude's
  `transcript_poll_stopped` warning for a failed final flush now reads
  "Transcript final flush failed after an unexpected error.", without "at exit",
  since runtime cleanup can now run that flush while the PTY lives.

- Sessions start again for macOS users whose login shell is `/bin/bash` or
  `/bin/sh`. macOS's bash 3.2, started as an interactive login shell, closes
  every inherited descriptor above stderr, so the probe start line added for
  slow profiles never arrived on descriptor 3. Every `--version`, `--help` and
  `update` probe, and the CLI's agent detection, failed with `login shell
  exited with status 0 before starting the probe command`
  (`phase: "login_shell"`), even though the command had run. A shell that
  closed descriptor 3 now writes the line on stdout, and Elwood removes it from
  the captured output.

- A Codex `stop()` or `teardown()` that gives up waiting for the ended turn's record
  now says so. When the 2-second wait runs out with Codex still running, the session
  emits one content-free `turn_commit_wait_expired` warning, with its `activity`, before
  signaling Codex, even when `stop()` and `teardown()` overlap. A host can then tell
  that a resume may show that turn as interrupted.
- Stopping a Codex session as soon as a turn ends no longer cuts off Codex before it
  records the turn. Codex records a turn as complete only after its `Stop` hook
  returns, and Elwood reports `ready` from that hook, so a `stop()` or `teardown()`
  called at that `ready`, or from a `Stop` hook observer, could end Codex before it
  wrote the record. Resuming the conversation then showed "Conversation interrupted".
  Both now give Codex up to 2 seconds to record the turn before signaling it, about
  100 ms in practice; past that bound they proceed and the turn can still be lost.
  `kill()` still ends Codex at once.
- `listModels` and `setModel` now read each picker frame they wait for while
  opening and moving through the picker as soon as it renders, rather than at the
  next 100 ms poll. They return sooner and hold the session's
  input queue for less time. The poll remains as a fallback when no render
  notification arrives.

- A Codex session whose readiness falls back to the 60-second backstop now emits
  an `initial_ready_backstop` warning, so a host can tell it from ordinary
  readiness. The backstop releases readiness when Elwood never recognizes Codex's
  configured composer (the model footer), for example after a layout change in a
  new Codex release. Before, that readiness looked like any other.

- Removing a Codex transcript that Elwood was reading now emits
  `transcript_read_error` with `lastErrorCode: "ENOENT"` on each poll while the
  file is missing, and at the final flush if it is still gone, as a removed Claude
  transcript already does. Elwood used to
  read the missing file as an empty, truncated one and say nothing, so a host lost
  the session's transcript activity without a warning. A transcript that has not
  been created yet still waits silently.

- A Codex session no longer reports `ready` before a late directory-trust prompt
  is answered. Codex paints an empty composer while it boots, before its session is
  configured, and under load its trust prompt followed 11 to 31 seconds after the
  first frame. Elwood's 10-second readiness deadline fired on that boot composer,
  so the session reported `ready` before the prompt even appeared (24 of 32
  loaded launches on Codex 0.164). The deadline now waits for the composer with
  Codex's model footer, which appears once the session is configured, so a cold
  start can now take longer than 10 seconds to report `ready`.
  A backstop still releases readiness 60 seconds after the first frame if that
  footer is never recognized; a prompt painted after that would still follow
  `ready`.

- `autotrust` no longer sends "1" to Codex as a user message. On a loaded
  machine Codex 0.164 can take the directory-trust answer (`1` + Enter) but
  paint its composer more than 250 ms later, and Elwood's retry typed the answer
  again into that composer, which submitted "1" as a turn to the model. The
  number is now typed once. Codex retries are Enter alone while the gate's
  caret is on the affirmative, which confirms the gate and does nothing on an
  empty composer. Other numbered gates are answered again only after new output
  still shows the gate.

- With `autotrust`, keys a caller sends with `sendKeys` (or `terminal.sendInput`,
  `xterm.input`) while a trust prompt is on screen now hand that prompt to the
  caller: Elwood stops answering it. Before, its retry could follow the caller's
  keys. When the CLI had already left the prompt but Elwood's screen had not caught
  up, that retry landed in the composer and submitted the caller's text along with
  the answer. A prompt the caller owns that stays up past five seconds is reported
  `blocked`, as before; a later trust prompt is answered as usual. The same keys
  also stop Elwood retrying its skip choice on a Codex update prompt, which could
  otherwise follow them onto whatever Codex drew next. Elwood then leaves that
  update prompt to the caller until Codex shows its composer.

- A successful `listModels` or `setModel` no longer releases queued input on the
  first frame without the picker. It now waits until no part of the picker has
  been the bottom of the screen across five readings at least 40 ms apart. Before,
  a blank or half-painted repaint could end the operation and let a queued
  message's Enter land in the picker when it painted again, applying the
  highlighted model. Picker text quoted above the composer does not hold the
  operation. Each reading first renders all output the terminal has received, and
  one that cannot fails the operation with `model_automation_failed` instead of
  reporting success.
- A Codex turn the agent rejects, for example one run with an unknown model, now
  fails with `turn_failed`. `CodexSession.send` rejects, `stream` throws after the
  events it already yielded, and `elwood run` exits 1, as Claude rejections already
  do. Codex fires no `Stop` hook for such a turn. On Codex 0.164.0, `send` resolved
  `''` about 20 seconds later, as if the turn had succeeded with an empty reply, or
  stayed pending until the CLI exited, and `elwood run` exited 0 with an empty
  `response`. The evidence is the transcript's failed `task_complete` for the turn's own
  `turn_id`. The error message is Codex's `error.message`, and
  `details.agentError` is its `codex_error_info` kind (for example `other`).

- `autotrust` now reports an answered Claude folder-trust prompt. Claude erases
  the dialog as soon as it is answered, then shows a blank or banner-only screen
  until its composer paints. Elwood treated that screen as the answer being
  lost, so the `startup_prompt` activity (`workspace_trust`, for example
  `sent home+down+enter`) never fired: 0 of 30 real launches on Claude Code
  2.1.310 emitted it. The answer is now reported once, when the composer
  appears. Codex 0.164 lost its directory-trust answers the same way (0 of 16
  fresh git-folder launches reported one); they are now reported too.

- A failed start or resume (`startClaude`, `startCodex`, `resumeClaude`,
  `resumeCodex`) whose cleanup could not confirm that the CLI's process group was
  reaped now says so. The typed startup error keeps its code and
  message and gains `details.cleanupErrorCode` (an allowlisted errno, else
  `UnknownError`) and `details.cleanupProcessGroupId`, which is for diagnosis only and
  must never be signaled. Before, that failure was dropped silently. When a PTY is not
  confirmed terminated and its group reap fails too, `termination_failed` now also
  carries the reap's errno as `details.reapErrno`, next to `details.reapError`.

- On Claude Code 2.1.310, `send` no longer returns an empty or truncated reply, and
  `stream` no longer ends early, when a turn takes more than about two seconds to
  produce text. A Claude session also stays `running` for the whole turn instead of
  flipping to `ready` and back about once a second. Claude 2.1.310 alternates its
  working window title between `◐` and `◑`, and Elwood read every `◑` frame as idle.
  An ergonomic turn treated that false `ready` as the start of its 2-second quiet
  window. Both half circles now mean working.

- A failed start or resume no longer signals a CLI that already exited during startup,
  and no longer reaps its process group a second time. The leader's pid could already
  belong to another process. Cleanup used to send that pid SIGTERM and then SIGKILL and
  wait about six seconds for an exit that had already happened.

- Resuming a Codex 0.164.0 session no longer reports a phantom `running` → `ready`
  turn shortly after readiness, which a host could show as a false unread reply.
  Codex 0.164.0 first paints `Resuming session…` above its composer and then loads the
  conversation under a working title spinner; Elwood counted the placeholder's repaints
  as proof the replay had finished. It now waits for that load to end. When the replayed
  conversation ends in `Conversation interrupted`, the false turn appeared twice.
- `stop()` and `kill()` reject with `termination_failed` when signaling the PTY itself
  throws. They used to pass the raw system error through, whose own `code` (for example
  `ESRCH`) read like an Elwood error name. The underlying message is kept as
  `details.cause`, with `errno`, `syscall` and `path` when present.

- A slow login-shell profile no longer fails startup as `claude_start_failed` /
  `codex_start_failed` ("`--version` failed", `ETIMEDOUT`). Preflight probes run
  through the user's interactive login shell, and the fixed 15-second bound counted
  loading that profile as the CLI's time. Under 16 concurrent headless runs on a
  loaded machine the profile alone took 7–19 seconds, while the CLI answered in
  milliseconds. The shell now has 60 seconds to load the profile, and the CLI still
  has 15 seconds from then. A shell that never starts the probe, by timing out or by
  exiting first, fails with a cause naming the login shell and `details.phase:
  "login_shell"`; for `autoupdate` the `agent_update_failed` warning carries
  `errorCode: "login_shell_failed"`. The profile's own startup output is left out of
  both, since it can contain expanded secrets. A contender waiting on another process's update
  now waits up to 165 seconds instead of 60, so it does not give up and re-read the
  version while the owner's version and update probes are still within their bounds.

- `autotrust` no longer reports a Claude folder-trust prompt that it has
  already answered as needing attention. Claude erases the dialog at once but
  can take several seconds to paint its composer, longer under load. Elwood
  counted that wait against the prompt's five-second limit, so the session
  briefly went `blocked` with `claude-workspace_trust-prompt` attention while no
  prompt was on screen. That happened in 17 of the 27 launches that reached
  `ready` (out of 30 started, 10 at a time in fresh folders) on Claude Code
  2.1.310. Headless `elwood run` killed those sessions
  and failed with `blocked_prompt` (5 of 7 concurrent fresh-folder runs). The
  limit now counts only time the prompt is on screen. Queued input is still
  held until Claude's composer appears.

- A fresh Claude session no longer emits `transcript_read_error` (`ENOENT`) while it waits
  for its first turn. Claude names its transcript at startup but writes the file only once
  a turn begins, and Elwood had reported each poll of the missing file as a read error.
  Removing a transcript after it existed still warns, as does any other read failure.
- A Claude transcript removed between a poll's size check and its read now warns
  `transcript_read_error` (`ENOENT`) on that poll. Before, the read took the missing file
  for a truncation: it skipped the warning and rewound to the start, so a file restored
  before the next poll replayed its earlier records as new activity. The same warning
  now covers a seen transcript that is missing when a stopped subagent's transcript is
  drained, at the final flush, and at a `Stop`-first tail recovery, which each read it
  as empty before. A transcript that was never created still reads as nothing.
- `listModels` and `setModel` no longer send a picker key into a prompt that has
  reached the terminal but has not rendered yet. Each arrow, selecting key, follow-up
  answer and Escape is now decided after every received byte is rendered, like
  queued input and failure cleanup already were. If the screen cannot be verified,
  the key is withheld and the operation fails with `model_automation_failed`.
  Before, an arrow chosen from the stale picker frame could move a permission or
  question prompt's selection.

- A Claude turn that Claude itself rejects, such as one sent with a model that does not
  exist, now fails with the new `turn_failed` error instead of passing as a successful
  reply. `ClaudeSession.send` rejects and `stream` throws after its collected events;
  `error.details.agentError` carries Claude's error name (for example `model_not_found`).
  `elwood run` exits 1 with a `turn_failed` error record where it used to exit 0 and
  print Claude's error text as the response. A late rejection whose `prompt_id` names an
  earlier submission than the current turn's does not fail the current turn. When either
  hook lacks a `prompt_id`, a rejection that arrives during a turn is attributed to that
  turn.

- A failed model operation no longer releases queued input on a blank or half-painted
  frame left after its cleanup. Elwood never sends a key, Escape included, to a picker
  that has not finished painting or to a bare `Select model` header, which agent output
  can print; failure cleanup cancels the dialog once it is recognizable. Until the
  composer is positively clear, queued input stays held, because Enter on a repainting
  picker applies its highlighted model.

- Claude `listModels`, `listClaudeModels` and `setModel` work on accounts whose model
  list is longer than the picker's ten-row window, and on any row whose effort control
  is Medium, High or Max. Elwood now recognizes the scrolled picker (`↑`/`↓` rows,
  `… +K models`) and every measured effort glyph, and follows the cursor across a
  scrolling window. `listModels` also returns the `↓`-marked last visible row, with the
  marker kept in its `raw`.
- Claude `listModels()` and `listClaudeModels()` return every model the `/model`
  picker lists, not just its ten-row window: an account with 13 models now gets 13
  rows, in picker order. Elwood reveals the hidden rows with arrow keys and then
  cancels, so the model and effort are unchanged. `setModel` can select any listed
  row, including one outside the window, walking only until that row is on screen,
  and an unknown id's error lists every row. The list's length is the highest
  rendered row plus the `… +K models` count, and `K` falls as the window scrolls
  while that sum stays the same. A frame that marks rows hidden without a count, or
  implies a different length from the first one read, is never acted on: Elwood waits
  for a repaint that matches, and fails with `model_automation_failed` at the timeout
  rather than returning part of the list. A frame with no count line is read as the
  whole list; Claude 2.1.310 paints that line before the dialog's footer, so a complete
  dialog always carries it.
- `listModels` and `listClaudeModels` no longer return a partial catalog read while
  the picker was still painting. Claude draws it over the slash-command menu, so a
  probe could return only `default`, or fail with "Could not parse any model picker
  rows". The picker is parsed only once the complete dialog is on screen.

- Codex `setModel` works on Codex 0.164.0, whose model picker closes with an
  `enter select · esc back` hint and whose reasoning screen closes with
  `enter default · s session · esc back`. It failed on its first key with "The model
  picker was replaced".

- Queued input stays held on a model dialog until the composer is positively
  clear. A dialog that survived a failed model operation's cleanup could be
  forgotten after five frames that neither grammar recognized, such as a blank
  or half-painted repaint. Any hold could also be cleared by five readings
  taken in the same instant. Either way, a queued message could be typed into
  the picker, where Enter applies the highlighted model.

- `autotrust` no longer makes Claude exit at its folder-trust prompt. Claude
  Code resets that dialog's selection to "No, exit" a moment after it opens, so
  under load Elwood's Enter could land on "No, exit" and the CLI exited with
  code 1 (7 of 60 fresh-folder launches on 2.1.310). Elwood now selects
  Claude's trust options by absolute position (Home, then Down) and sends Enter
  in the same write as that selection, so a reset, a delayed key, or a retried
  key can no longer confirm another option. The `startup_prompt` input text for
  cursor-layout prompts now names the absolute sequence (`home+enter`, or
  `home+` then one `down+` per row above the affirmative, then `enter`) instead
  of a cursor-relative label such as `enter`, `up+enter`, or `down+enter`.

- Codex `listModels()` and `listCodexModels()` no longer report the session's
  current model as the configured default. Codex 0.164 marks only the current
  row, so `isDefault` now follows `config.toml`: the `model` of the profile the
  root `profile` key selects, else the root `model`. A session launched or
  switched onto another model keeps the configured row as its default, and a
  config that names no model reports no default. A `config.toml` that exists but
  cannot be read rejects the listing with `model_automation_failed`. Listings and
  `setModel` restores keep using the `config.toml` path captured at session
  launch, even if `CODEX_HOME` changes later.

- Claude questions are raised again on Claude Code 2.1.310 and in named
  sessions (`name`). 2.1.310 pads the single-question header chip with a
  trailing space, and a named session draws its label into the border below the
  questionnaire; either one left the native dialog on screen without raising
  the question.

- Named Claude sessions (`name`) recognize their composer again. Claude insets
  the name into the composer's top rule, which kept trust clearance and
  empty-input checks from matching: a named session in an untrusted folder
  stayed `blocked` after autotrust answered the trust prompt.

- Claude sessions recognize their idle composer in every permission mode after
  the version banner has scrolled away. Elwood accepted only the exact footers
  captured earlier (auto mode and don't ask on 2.1.278, manual mode on 2.1.305).
  On Claude Code 2.1.310 it missed bypass permissions, accept edits and plan mode,
  footers that end in a token count or effort level, and footers that have
  dropped the `← for agents` hint. In a long session, trust clearance, the
  model-picker hold and empty-input checks then never saw the idle composer.

## [0.2.1] - 2026-10-24

- Reduce median active Elwood CPU by 11.3% in the measured 50-session workload
  by sharing completed-frame text, preserving fresh public snapshots and direct
  xterm writes.

## [0.2.0] - 2026-10-22

- Codex question turns settle after native completion even when consecutive answer echoes contain caret-like multiline text.

- Preserve overlapping Claude question requests across out-of-order hook outcomes;
  require unambiguous native panel evidence before exposing answer authority.

- Cancel question writes before physical dispatch when the operation aborts, including after its final frame guard.
- Retain uncertain native answer reservations until both the physical write and correlated native ownership settle.
- Preserve in-flight question request IDs through same-key metadata redraws so late native acceptance closes the original request.


- Preserve the first question-observer failure diagnostic when pending listener
  promises exceed the notification registration cap.

- Keep native Claude questionnaires blocking when question text contains composer-like carets, fences, or navigation-footer copy.


- Report contained question and companion activity listener failures once per
  live session with a content-free `question_observer_failed` warning.

- Expose live Claude and Codex questionnaires through typed `question` events,
  structured normalized activity, `listQuestions()` and `answerQuestions()`;
  submit grouped forms and independent queued answers while preserving running
  turns, guarding native editors and verifying native acceptance. Budget
  disablement emits a content-free `question_automation_disabled` warning.

- Enforce the existing required payloads in transcript activity types: Codex progress carries text and its Codex/transcript identity, and Claude transcript projections retain their per-kind required fields.

- Keep Codex turns running through native working pulses and hold input at blocking modal and queued question editors; recognize the captured Plan mode footer when verifying an empty composer.

- Recognize Claude Code 2.1.305 question dialogs as blocking input and accept its captured manual-mode footer when verifying an empty composer.

- Expose committed Codex commentary as readable `assistant_progress` activity, distinct from final answers; suppress non-final legacy mirrors so progress neither duplicates nor completes replies.

- Expose Claude's advance login-renewal notices as `login_expiring` warnings and activities with `expiresInDays` and `/login`, including startup and resume, without interrupting the session.

- Report a submission-specific `wait_timeout` when raw input replaces ergonomic input awaiting empty-composer confirmation, preserving model-picker diagnostics for picker operations.
- Codex recovery now withholds retry Enter and empty-input acknowledgement when partial native approval rows remain above a retained composer.
- Keep ergonomic response collection behind selected loop and persona completion; bind Codex transcript content and Stop completeness to the native acceptance of the caller's own submitted turn, including headless CLI sessions.

- Prevent retained working and interrupt frames from releasing input physically submitted inside Stop callbacks; expired raw Stop input retains its timeout error after teardown.
- Stop ergonomic turn recovery when its consumer settles, retaining captured images and the next turn’s slot until input cleanup and the current native boundary finish.

- Retain staged text and images for initial and replay ergonomic submissions until fresh native empty-input evidence, preserving cancellation cleanup and the ordinary first-Enter send contract.

- Preserve asynchronous hook decisions after the generated bridge child finishes sending its request, instead of closing the reply stream early.
- Recover image-only and whitespace submissions only from a fresh live composer render after each Enter attempt; cached text or image drafts cannot trigger an extra Enter.

- Preserve each observer registration’s async context when listeners reuse a pending Promise.

- Require a current first-party banner for every automated Codex update-menu selection, withholding all bannerless choices while retaining the input hold; renumbered or removed safe options revoke the old retry, and a fresh bounded bannered block can recover from overflow.
- Keep landing-page pickup responsive while preparing every suspended-animation sheet, cancelling obsolete pickup work on drop, reset or teardown.
- Clear completed Codex trust gates when the native idle composer displays its warning-count footer, so queued input can reach readiness.

- Bound each session’s queued input to 1,024 outstanding operations and 8 MiB of text; excess submissions reject with `input_queue_full` without writing to the terminal, and oversized personas reject before session startup.
- Preserve Codex hook input, decisions, and turn bookkeeping when observers mutate, throw, or reject, with one bounded `hook_observer_failed` warning per hook and a distinct lifecycle warning for standalone initial-ready observer rejections.

- Reject late queue-backed input from context-preserving continuations of completed or timed-out Stop callbacks and observers, so it cannot overtake a successor released by that Stop.

- Keep a prompt submitted from a Stop callback running when the older Stop completes, without blocking immediate callback input.

- Recover swallowed prompt Enters only from the live idle composer, without mistaking transcript text or working frames for staged input. Fresh empty input ends recovery; unverifiable frames get bounded observation retries.

- Prepare complete automatic landing-page gestures and facing actions before playback, releasing obsolete task loads without interrupting manual input.
- Discard expired automatic landing-page actions before readiness checks, preventing late assets from triggering an obsolete gesture or facing change.
- Reuse decoded idle sheets across landing-page actions instead of repeatedly fetching and decoding them after playback changes.

- Prepare and retain the complete initial idle animation before replacing the landing-page fallback.

- Prepare complete landing-page gesture and facing animations before delivery, cancel obsolete requests, and avoid loading input that cannot play in the current state.

- Stop background recovery Enter presses when the native composer is positively empty, even if submitted text remains in the transcript.

- Avoid repeatedly scanning blocked turn input when model and login controls cross a queued backlog.

- Stop background paste-recovery Enter presses after native submission activity, including while the first physical Enter is pending.

- Require one current native update-option block before sending a skip key. Ambiguous repaints revoke the attempt; only fresh unambiguous banner evidence with a current safe choice can reauthorize it and renew its bounded CLI grace, including the same version pair.

- Recognize Codex’s native ✨ update banner when its options are clipped, keeping the partial updater input-blocking.

- Renew the CLI update grace period once for a changed Codex version banner, using generation-tagged attention without reporting a successful skip.

- Treat a changed Codex update version banner as a new appearance, cancelling old retries and allowing a fresh bounded skip attempt.

- Keep Codex update retries revoked after unknown or blank replacement frames until authoritative native composer clearance or fresh banner evidence appears; late writes cannot report an answer for a superseded dialog.
- Hold scheduled loop delivery through ergonomic caller turns, preventing a due
  loop from accepting or completing a caller prompt that needs recovery.

- Recognize Claude 2.1.281's half-circle working title, keeping active turns and
  trust holds from appearing idle while the input composer remains visible.

- Keep startup persona responses out of ergonomic caller turns, including when
  the persona and caller submit identical text or its transcript arrives after
  readiness. Closing cancels waiting callers even if process shutdown fails.

- Preserve cancellation when a queued submission's pending physical write later
  succeeds, so the cancelled operation cannot report success. Commit successful
  loop delivery before running observers can cancel it, preserving fired telemetry.

- Stop delayed paste-recovery Enter keys after raw caller input takes ownership of
  the draft, including direct terminal and xterm input.

- Report an automated Codex update skip as answered only after verified native
  composer clearance; completed writes without a reader or into replaced dialogs
  settle quietly without false startup success.

- Recognize Codex 0.156.1 capitalized model footers when confirming an empty
  native composer, so cancelled draft cleanup can release queued successor input.

- Recognize Codex 0.156.1 folder-access trust prompts, keeping queued input held
  and approving only the known choice when `autotrust` is enabled.

- Keep queued Codex input held when an update screen becomes an unknown or partial
  dialog, until its live native composer returns; a stale visible cursor cannot
  clear replacement text above the old composer. Specific trust rules retain their
  diagnostic labels; other retained holds report `codex-unidentified-dialog`.

- Retry an ignored Codex prompt Enter when the staged paste contains stripped
  control characters, tabs, or carriage-return line breaks.

- Preserve picker and cancelled-draft cleanup authority across automatic terminal
  protocol replies and startup automation; actual caller input still revokes it.

- Clear cancelled staged text and images before successor input, deferring cleanup
  through dialogs. Failed cleanup holds the draft; raw input through `sendKeys`,
  `terminal.sendInput`, or `xterm.input` revokes cleanup authority, and shutdown drops
  deferred cleanup without waiting. A physical clear must be confirmed by a fresh
  native empty composer before successor input; Claude recognizes both its native
  idle screen and its post-picker composer.

- Hold image paste keys until received terminal output has rendered and blocking
  dialogs have cleared, then capture the chip count immediately before pasting.
  Permanent render failures reject the attachment and release its clipboard lock;
  session cancellation also prevents pending image input.

- Cancel Codex update retry timers and pending automated keys when the session closes,
  suppressing late startup success and write-failure warnings after disposal.

- Release cancelled config-lock and clipboard-lock waiters immediately, including
  captured session state, while active holders retain ownership through cleanup.

- Select Codex update-skip choices only from a current validated first-party
  banner and safe-option block, after the update action when present. Selection
  uses the current numbering and never selects an update action whose label also
  contains a skip phrase.

- Keep an acquired Codex config or clipboard lock operation pending until its task
  finishes cleanup when cancellation arrives; cancellable config-lock waiters still
  cancel immediately. Codex model-switch deadlines also
  cancel config-lock waits and release the waiting session input slot. A timeout
  before successful `/model` dispatch never cancels a picker opened by someone else,
  and the initial picker-screen wait honors the same operation deadline. Ordinary
  queued text and images remain held through foreign picker repaints. Raw user
  input revokes active picker navigation and cleanup, including config restoration
  that could overwrite a human choice; uncertain changed defaults emit the existing
  persistence warning.

- Keep queued input suspended when a human dialog clears while the agent is still working,
  including deferred startup readiness. A caller prompt held by the dialog reasserts running
  when it submits, before a queued follow-up can dispatch. Blank or caret-only repaints
  retain the hold until a verified idle composer, and resumed working clearance preserves
  the next idle transition.

- Refresh attention diagnostics when a blocked session switches to a differently
  classified prompt, so consumers see the current human decision instead of a
  stale update-prompt label. Repainting the same blocking rules stays quiet.
- Keep a visible human prompt blocked through caller submissions and rendered turn
  starts or endings, including late Stop hooks. Readiness resumes only after clearance.

- Preserve live-loop cancellation notifications through delayed or retried kill and teardown cleanup. Previously, pausing the scheduler before clearing definitions could suppress these events.

- Keep each live launch’s hook policy bound to its own bridge artifacts during resume. Pending resumes reconcile durable loops at activation; destructive predecessor shutdown joins the reservation outcome, and rollback attempts all files before reporting restoration failures.

- Claude and Codex transcript and diagnostic listeners can stop a session without
  moving pending activity past terminal exit, duplicating finalization, or signaling
  an already-exited PTY while its final transcript records are being delivered.
  An exit immediately after startup waits for already-scheduled warning delivery,
  preserving both subscriber visibility and diagnostic-before-exit ordering.
  A session resumed from an exit listener retains its files, socket, and loops when
  the old launch finishes a deferred or repeated teardown, including through supported
  state-path aliases. Failed launches restore their own published files, CLI cleanup
  preserves newer owners, and superseded loop mutations reject instead of silently
  reporting success.

- Keep human-owned trust gates blocked through partial and unknown replacement
  frames. Queued caller input resumes only after positive native clearance. Both
  adapters withhold trust retries and human clearance while received output is
  still rendering or the terminal has reported a render failure. Claude also waits
  for its visible native input cursor after the final composer paint and retains
  the hold while its native working title remains active.

- Recognize Codex's native composer beneath numbered transcript output and with
  its older model footer. A newly painted bare caret cannot borrow an earlier
  composer's footer to release input held for a human dialog. Live clearance now
  requires its visible input cursor after all received batches render; native approval
  headers still override a stale visible cursor. Partial dialogs stay held while
  ordinary transcript prose and numbered user prompts remain valid. Exact-shaped
  native working rows remain conservatively held. Active work and incomplete
  welcome-box fragments cannot release input.

- Keep Codex transcript polling and activity delivery running after a public listener
  throws, so later records (including turn failure evidence) still reach subscribers.
  The content-free `transcript_listener_error` warning identifies the failed delivery
  channel at most once per watcher, after synchronous transcript delivery;
  `transcript_poll_stopped` remains reserved for actual reader failures.

- Detect startup authentication errors from PTY bytes as soon as they arrive.
  Slow or stalled terminal rendering no longer lets an already-received error
  escape the bounded startup check in either adapter. Startup capture retains only
  a complete UTF-8 prefix within 64 KiB, including for oversized raw chunks.

- Reject hook rewrites with unsafe JSON values or accessors before serialization, and stop wide-value inspection at the validation budget.

- Reject cyclic and excessively deep or wide schema-less hook inputs
  and rewrites without throwing. Validation allows at most 128 edges of depth
  and 100,000 value visits, counting repeated children on each path. Invalid rewrites
  now report `invalid_response` and return no decision instead of reaching the JSON
  serializer with an unserializable graph.
- Reject `NaN` and `±Infinity` in numeric Claude hook fields, for every tool. Because
  `JSON.stringify` encodes them as `null`, a hook handler that returned one in an
  `updatedInput` rewrite used to send the CLI a `null` where its schema requires a
  number. Concrete tool schemas enforce this per field; schema-less tools (MCP,
  generic, future) enforce it structurally over the whole value, nested records and
  arrays included. Such a rewrite is now an invalid result: the bridge fails open with
  no decision and emits `hookError`.

- Bind the Claude browser-tools decline to session disposal. After `stop()`,
  `kill()`, or PTY exit the decline is no longer attempted, and one already in flight
  settles as a cancellation, so a closed session no longer emits a late
  `startup_prompt` / `startup_prompt_write_failed`. The keystroke itself is bound too:
  the non-trust automation barrier waits for render settlement, and a write parked there
  is interrupted immediately on disposal, releases its observation timer, and never
  delivers a stale Escape to a dead PTY. Trust automation already had this lifetime.

- Preserve Claude hook decisions and lifecycle progress when observational listeners
  throw or return rejecting Promises, with one bounded `hook_observer_failed` warning
  per affected invocation. Pending observers do not delay hook replies; diagnostic
  retention is capped at 1,024 registrations per emitter. Promise constructor/species
  metadata must permit native reaction attachment; attachment throws are reported
  and remain retryable. Warning payloads are
  frozen before delivery. Incoming
  Claude hook events are deeply frozen before observation, and throwing observers
  no longer truncate subsequent hook-scoped status or transcript notifications.

- Snapshot Claude hook responses before validation so later mutations or custom accessors cannot replace validated rewrites on the wire. Capture wire output and blocking decisions before activity listeners run.

- Preserve Claude `StopFailure` hooks with missing or changed diagnostic fields. Those
  fields are now typed as optional `unknown`, matching ingress. Browser logs show a
  bounded rejection reason instead of unrelated assistant text or a blank summary.

- Route Codex tool-keyed hooks from own properties only. A `PreToolUse` map is a
  plain object, so a tool name matching an inherited member (anything on
  `Object.prototype`, or a key on a caller-supplied prototype) used to resolve to a
  function the caller never registered for that tool and run it against the hook
  event. Both the exact-name and `unknown` lookups now require an own property,
  matching Claude routing.
- Hold the cross-process update lease for an aborted updater's surviving process
  group. An update probe that was aborted without confirming its process group had
  exited used to release the lease anyway, so another Elwood host could start a
  competing installer while the first updater's descendants were still running.
- Bound the cleanup of an aborted version, capability, or update probe to one
  extra second: retry process-group termination, fall back to the direct child,
  and keep an unresolved group on an asynchronous reaper that never extends host
  shutdown or retains captured output. A process group is signaled only while its
  leader is unreaped, so a reissued group id is never killed. An update probe whose
  group stays unconfirmed now reports that group in its typed error details.
- Serialize `listModels`/`setModel` through the session input queue: a model
  operation owns the queue until its picker flow settles, so overlapping model
  calls, queued commands, and messages can no longer be typed into a picker while
  the operation that opened it is running. `compact`'s delayed recovery Enter is
  cancelled once a later operation takes the composer, rather than queued behind it.
- A Codex `setModel` interrupted by session termination waits for the CLI process
  to exit before restoring `config.toml`, bounded at five seconds so a process that
  never reports an exit cannot hold the shared config lock. Session status alone
  (`stopped`, `killed`, `torn_down`) no longer releases the restore, since teardown
  records those even when its signal did not take. The wait now applies whether the
  switch succeeded or failed: the question is whether the dying CLI can still write
  `config.toml`, not whether Elwood's automation worked.
- A Codex `setModel` still waiting for the process-wide `config.toml` lock rejects
  with `session_not_running` as soon as its own session closes, instead of staying
  pending until the session ahead of it finishes its transaction and exit wait. A
  cancelled call never runs its switch when the lock frees.
- Stop non-trust startup automation from writing into a trust gate that arrived while
  the previous screen was still rendering. The Codex update skip (including its retries)
  and the Claude browser-tools decline now observe all received PTY output and re-check
  the settled frame before writing, the guarantee queued caller input already had. A
  withheld write is silent and stays retryable; the trust responder is unaffected and
  still answers trust gates itself.
- Hold queued input on an unrecognized gate behind a recognized native header
  prefix (`Do you`, `Is this`, `Trust the`, ... — PRD §5.4 lists them): a reworded
  question with selectable options and a frame-ending native footer, and no
  conversation above, now blocks for a human with the attention label
  `<agent>-unknown_gate-prompt` under every `autotrust` value and is never answered
  automatically; previously readiness could type the queued message and Enter
  into it. Gates outside that grammar (other leading words, other footers) are
  still not held. Dialogs that already block keep their existing labels.
- Bound Codex in-TUI update skipping to one attempt per appearance of the update
  screen: an exhausted retry no longer restarts on the next frame of the same
  screen, and a stale attempt's late completion cannot start an overlapping retry
  loop or report success or a write failure for the newer screen. A skip write
  rejected after the update screen already cleared no longer fails a healthy
  headless run as `blocked_prompt`. A reappearing update screen is still skipped again.
- Emit the `attention` activity for a blocking prompt that painted while the
  session was still `starting`. Such a session already became `blocked`, but
  without the human-decision event, so a headless `elwood` run never reported
  `blocked_prompt`.
- A failed `listModels`/`setModel` now cancels the model dialog it left open
  before releasing queued input, and holds queued messages, commands, and `/login`
  while a dialog it could not cancel stays visible. Picker text quoted in a reply
  is never cancelled, so cleanup cannot interrupt a running turn.
- `setModel` no longer resolves on the partially painted frame that precedes
  Claude's cache warning (it reported success without confirming the switch), and
  queued input stays held while a Claude switch dialog is still painting.
- Model-picker cleanup also covers a dialog that paints up to a second after the
  failure (a late picker, Codex's reasoning level, Claude's cache warning). A model
  operation now rejects without writing when model picker text is already visible.
- `compact`'s recovery Enter can no longer be typed into a model picker opened by
  a concurrent `listModels`/`setModel` (where Enter saves the highlighted model as
  the default): it now waits for the picker operation to release the input queue.
- Snapshot image bytes and relative paths when facade methods are called, including
  turns queued behind another response or waiting for session startup. Facade copies
  count against the same 200 MiB per-session ceiling as sends on the raw `session`.
- Reject FIFO state/config files without hanging.
- Runtime cleanup drains received terminal output before disposing the renderer —
  for up to one second, including output that arrives while it drains — so the
  final `terminal:data` tail is delivered (possibly after `terminal:exit`) instead
  of dropped. `--head` now mirrors through cleanup, so the agent's final frames
  (for example its last words before an unexpected exit) are no longer cut off.
- Bind automatic trust approvals to the active dialog and revalidate every write,
  preventing quoted transcript headers or unknown intervening titles from
  authorizing unrelated permissions. Cancel stale trust attempts quietly while
  keeping readiness and queued input gated until the native dialog clears. Retry
  early numbered trust writes that the CLI has not yet consumed. Bound both
  navigation styles to the session and current dialog generation; unsupported or
  exhausted trust automation becomes a recoverable block after five seconds.
  Image attachment is held by the same trust gate as text input.
- Require a trust dialog's native explanatory copy before any automatic approval:
  a bare allowlisted header with affirmative options is held, never typed into,
  and becomes answerable only once its native body paints (recoverable `blocked`
  after five seconds otherwise). Skill, plugin, and MCP gates are unchanged.
- Release the cross-process update lease atomically. A second Elwood process polling
  at the instant the owner released could recover the half-removed lease as stale
  and run a duplicate `autoupdate` right after the first.
- Publish the cross-process update lease atomically. An Elwood process killed
  while claiming the lease could leave a partial owner record that made every
  later `autoupdate` on that machine skip its update until the cache was removed
  by hand.
- Queued input now renders and observes all PTY output already received before
  each write, so a trust or permission dialog that was received but not yet
  rendered still holds the paste, its Enter, and recovery Enters. The compact
  recovery Enter follows the same rule and is cancelled once a later queued
  operation dispatches. On the terminal handle, `settled()` now also covers output
  received while waiting (it still never rejects), and the new read-only
  `renderFailed` property reports a failed render, after which queued input stays
  withheld.
- Keep text CLI output limited to agent responses by default. Use
  `--show-session-id` to print the retained session ID on stderr, or find it
  with `elwood sessions`. Session retention and JSON/JSONL records are unchanged.
- Batch terminal rendering, improving throughput across parallel sessions:
  adjacent PTY chunks share one render and one `terminal:data` event (at most
  64 KiB, flushed within 4 ms), so event chunk boundaries and intermediate frames
  are no longer guaranteed. Direct terminal disposal settles pending writes
  immediately. Real PTY reads pause when unrendered output reaches 1 MiB and resume
  below 512 KiB, so a runaway producer cannot grow the render backlog without bound;
  a paused PTY resumes as soon as its child exits, so a draining backlog cannot
  strand unread tail output.
- Recognize only native Codex warning banners, keeping quoted private prompt text
  out of warning events by requiring the current native welcome region.
- Validate all concrete Claude tool input fields and typed hook fields, constrain
  permission rewrites to tool-specific handlers, and accept nullable Codex descriptions.
- Bound the wait for another Elwood process's `autoupdate` to 60 seconds. A
  contender that is still waiting then skips its update and continues with the
  installed CLI, reporting `agent_update_failed` with `errorCode: "update_active"`
  instead of waiting indefinitely; the active owner's lease is never evicted.
- Match Claude task identifiers and plan permission objects to the native hook
  schemas so valid task and plan inputs reach their handlers.
- Contain clipboard pipe failures during Codex image attachment, and retain the
  clipboard lock until the restore process exits.

## [0.1.3] - 2026-09-14

- Keep live session warnings quiet in text and JSON CLI output, including model
  discovery; enable them with `--verbose` or `--debug`. JSONL warning events and
  fatal errors remain available as before.

- List both Claude and Codex catalogs in bare `elwood models`, with agent
  associations, partial failure diagnostics, and one shared timeout budget.
  Explicit `--agent` keeps the single-agent output contract.

- Preserve new CLI sessions by default so they can be listed and resumed; use
  `--ephemeral` to remove new or resumed Elwood state after the run.

## [0.1.2] - 2026-09-13

- Preserve the inherited PATH when an interactive login shell exits successfully
  without returning the PATH probe.

- Keep permission dialogs blocking across cursor movement and hold slash-command
  input and recovery Enter while a decision is pending; cancel expired picker submissions.
- Reject planted state-directory and generated-file links before permission changes or writes.
- Forward `highTrust` on start-or-resume, wait for model-discovery readiness,
  and resolve session listings independently of agent-specific environment defaults.
- Align foreground interactive launches with login-shell agent detection.
- Correct trust and IPC-persistence documentation, include linked package references,
  and revalidate mutable website sprites using fresh URLs for previously cached clients.

## [0.1.1]

First usable public release.

0.1.0 was published from a checkout that sat 18 commits behind `main`. It
shipped without the `resume`, `sessions`, `interactive` and `models`
subcommands, without `--high-trust`, without agent auto-detection, and with a
stale README. Nothing was wrong with 0.1.0's own code; it was simply built from
the wrong commit. 0.1.1 is the same work published from `main`, and is the
version to install.

### Added

- **The `elwood` CLI now explains and cleanly overrides its effective behavior.**
  `--no-stream` and `--no-verbose` reverse inherited boolean defaults,
  `--no-defaults` bypasses saved config and `ELWOOD_*` run settings, and
  `elwood config effective` reports validated launch/output values with their
  provenance without starting an agent. Routine warnings now reach stderr for
  text and JSON runs, `--verbose` is a concise elapsed progress view, and
  `--debug` retains full sanitized event detail. JSONL records include elapsed
  timing plus tool-call correlation IDs when available. Help, validation errors,
  resume/persona/ephemeral wording, and the new scripting guide now make defaults,
  recovery actions, and lifecycle effects explicit. (§5.8/§12A,
  C-API-48/C-CLI-02/03/08/10/11/14/19/20)
- **The `elwood` CLI can now mirror the live agent TUI in the current terminal.**
  `--head` sends the agent's ordered raw VT/ANSI stream to terminal stderr while
  preserving the final text or JSON result on stdout, including cursor-addressed
  redraws, alternate screens, colors, spinners, and OSC title changes. It follows
  terminal resizes, restores terminal modes on every handled outcome, and treats
  Ctrl-C like the existing interrupt lifecycle. The display is intentionally
  view-only and cannot be combined with `--stream`, `--verbose`, or JSONL.
  Pending terminal writes are bounded by bytes and frame count, so a stalled
  terminal becomes a clean run failure instead of an unbounded memory queue.
  An argument-free `elwood` invocation now prints help instead of waiting for a
  prompt. (§12A.1/§12A.6, C-CLI-02/C-CLI-18)
- **The `elwood` CLI gained `sessions`, `resume`, `interactive`, and `models`
  commands.** `elwood sessions` lists Elwood-owned session records (id, agent,
  workspace, `createdAt`/`lastUsedAt`, `resumable`, socket-presence `live`) as an
  aligned table or one `{"type":"sessions"}` JSON document without starting an
  agent. `elwood resume <id> [prompt...]` is a parse-time rewrite of
  `run --resume <id>`. `elwood interactive [id]` runs the real `claude`/`codex`
  TUI in the foreground with Elwood's resolved agent, model, effort, workspace,
  and posture passed as the agent's own flags — no PTY, automation, observation,
  or state — resuming a stored session's own conversation when given an id.
  `elwood models` starts the agent briefly, reads its model picker through the
  public `listModels` operation, tears the session down, and prints a table or a
  `{"type":"models"}` document of `AgentModelOption` rows. The adapters' launch
  flag mapping now lives in shared `claudeLaunchArguments`/`codexLaunchArguments`
  builders so interactive and headless launches cannot drift. (§12A.7–§12A.10,
  C-CLI-23 through C-CLI-26)

- Claude Code and Codex CLI adapters that run the real interactive CLI in a
  PTY, launched through the user's login shell, and observe it through a
  headless xterm.js model. macOS only; Claude Code 2.1.144+ and Codex CLI
  0.124.0+ with a `strictVersionCheck` option to fail closed on unparseable
  versions.
- `ClaudeSession` / `CodexSession` classes as the primary API: synchronous
  construction, lazy start on first use, `send(prompt)` returning the turn's
  assistant text, `stream(prompt)` yielding typed `text` / `thinking` /
  `tool_call` / `tool_result` events, and `close()`. Turns end on a
  deterministic transcript boundary, with no whole-turn timeout unless
  `timeoutMs` is passed. The eager `startClaude` / `startCodex` factories are
  deprecated but remain available.
- The full control surface on every session: `sendMessage`, `sendPrompt`,
  `sendGuidance`, `sendKeys` (string or raw `Uint8Array`), `resize`,
  `interrupt`, `compact`, `listModels`, `setModel`, `waitForStatus`,
  `waitForActivity`, `stop`, `kill`, and `teardown`, plus the exported
  `ElwoodAgentSession` type for code generic over either adapter.
- Typed hook handlers for Claude and Codex hook events, delivered over a
  local, token-protected IPC bridge with runtime validation. Handlers fail
  open; failures surface as `hookError`.
- A unified `activity` event stream (messages, reasoning, tool calls and
  results, web searches, hooks, warnings, lifecycle) with normalized
  `toolName` / `toolInput` / `toolOutput` / `turnId` fields, alongside `hook`,
  `hook:<Name>`, `warning`, `loop`, `status`, `terminal:data`,
  `terminal:exit`, and Codex-only `codex:transcript`.
- Raw `terminal:data` output for host-rendered terminals, with a 128 KB
  replay buffer for late subscribers and exactly-once `terminal:exit`.
- Persisted, resumable sessions: a minimal session record under
  `<cwd>/.elwood` or a caller `stateDir`, `resumeClaude` / `resumeCodex`, and
  `startOrResumeClaude` / `startOrResumeCodex`, which fall back to a fresh
  start only on `state_not_found`, `resume_unavailable`, or
  `adapter_mismatch`. Resume restores the persisted launch posture and
  reaches readiness in about one second.
- Recurring loops (`createLoop`, `listLoops`, `cancelLoop`, and the opt-in
  `parseLoopCommand` helper) with fixed or idle cadence, per-session limits,
  seven-day expiry, a redacted `loop` event, and a private sidecar that
  survives stop and resume.
- Image attachment on `send`, `stream`, and every send method via `images`
  (`{ path }` or `{ data, format }`), validated and bounded before submission
  and confirmed by the CLI's `[Image #N]` chip. Codex attachment drives the
  macOS clipboard under a process-wide lock.
- Model control: `listModels` / `setModel` through the adapter's `/model`
  picker without touching the user's saved defaults, `model` and
  `reasoningEffort` start options on both adapters, and the standalone
  `listClaudeModels` / `listCodexModels` probes.
- Claude login recovery: `claude_not_authenticated` at startup, a live
  `login_expired` warning mid-session, and `ClaudeSession.login()` to drive
  `/login` with a human-supplied authorization code.
- A `persona` start option delivered as the guaranteed first user message,
  and an optional best-effort `autoupdate` preflight that never fails a start
  when the installed CLI already meets the minimum version.
- Automatic answers for a narrow allowlist of startup prompts: workspace trust
  (opt-in `autotrust`), Codex hook-trust and update dialogs, and Claude's
  browser-tools onboarding. Any other dialog leaves the session `blocked`.
- The `elwood` executable: one headless turn with text, `--output json`, or
  `--output jsonl` protocols, `--stream`, `--verbose`, `--debug`, stdin and
  ordered `--image` input, `--timeout`, `--persona`, model and posture flags,
  `--keep` / `--resume` / `--ephemeral` continuation, signal-safe cleanup, and
  stable exit statuses (`0`, `1`, `2`, `124`, `130`).
- `--head` mode that mirrors the live agent TUI in the current terminal on
  stderr while keeping the final result on stdout, view-only, with terminal
  state restored on every outcome.
- `elwood config` with one strict global JSON file, typed keys, `ELWOOD_*`
  environment overrides, flag > environment > config > built-in precedence,
  `--no-defaults`, and `config effective` to explain resolved values and their
  sources without starting an agent.
- CLI agent auto-detection: with no `--agent`, `ELWOOD_AGENT`, or config
  `agent`, a new run tries `claude` then `codex` in the login shell and fails
  with `no_agent_found` (status 2) when neither resolves. Error records
  emitted before an agent was selected report `agent: null`.
- An agent-neutral "never ask for permissions" switch: `--high-trust` /
  `--no-high-trust`, `ELWOOD_HIGH_TRUST`, the `highTrust` config key, and
  `highTrust?: boolean` on both session classes and both resume functions. It
  expands to Claude `permissionMode: "bypassPermissions"` or Codex
  `sandbox: "danger-full-access"` with `approvalPolicy: "never"` before the
  posture is persisted and the process spawned. Combining it with an explicit
  per-agent posture is rejected: the CLI names both sources as a usage error and
  the library throws `claude_high_trust_conflict` / `codex_high_trust_conflict`.
  `config effective` reports `highTrust` and attributes the posture it decided
  to the high-trust source. Claude's one-time "running in Bypass Permissions
  mode" acceptance dialog is an allowlisted trust prompt answered under
  `autotrust` (`startup_prompt` label `bypass_permissions`).

### Changed

- Published as `@with-logic/elwood` under the MIT license.
- The published package runs no install scripts. `dist/` is built before publish
  (`prepublishOnly`) and shipped in the tarball, so `npm install -g
  @with-logic/elwood` needs no build step and raises no npm allow-scripts
  prompt for Elwood itself. Working from a checkout now requires an explicit
  `npm run build` before `npm link`.
- Warnings are live-only events. Nothing is persisted, replayed, or counted;
  there is no `session.warnings` property.
- The persisted session record holds only schema version, `elwoodSessionId`,
  adapter, `cwd`, and per-adapter resume state. Terminal size is not
  persisted; pass `initialSize` on resume.
- Codex `tool_call` activity reports the bare exec command as `toolInput`
  rather than the CLI's JavaScript harness wrapper.
- `ClaudeEventMap`, `ClaudeEventName`, and `ClaudeEventHandler` are the
  primary names for the Claude session event map; `ElwoodEventMap`,
  `ElwoodEventName`, and `ElwoodEventHandler` remain as deprecated aliases.
- An object-form Codex `PreToolUse` handler's `unknown` entry now receives only
  `mcp__*` / `unknown:*` tools; a `Bash` / `apply_patch` event with no per-tool
  handler yields no decision.
- The local dev apps are no longer compiled into `dist/`, and their `ws` and
  browser xterm dependencies moved to `devDependencies`, so consumers install
  only what the library uses.

### Fixed

- **Headed runs no longer suspend themselves or leave the invoking terminal unusable.**
  Interactive version and capability probes now run in an isolated process session,
  preventing their shell-managed commands from stealing the real terminal's foreground
  process group. `--head` can therefore restore cooked input and display modes before
  returning to an interactive shell, without a cleanup-time `SIGTTOU` stop or leaked
  terminal-protocol replies. Its defensive restore now also pops the Kitty keyboard
  enhancement mode used by current agent TUIs, so subsequent shell keystrokes remain
  ordinary text instead of encoded key-event sequences. (§12A.6, C-CLI-18)
- **Codex's startup update dialog no longer wedges headed or headless runs.**
  Codex 0.153.x can paint its numbered update menu before its input loop accepts
  the first safe Skip hotkey. Elwood now retries that hotkey for a bounded interval
  only after revalidating the complete current update dialog, and the CLI no longer
  mistakes the responder-owned dialog's replayed blocking edge for a human prompt.
  A persistent or unanswerable update dialog now fails and cleans up boundedly even
  without `--timeout`; no retry can escape into the composer or another dialog.
  (§5.5/§12A.2, C-CODEX-12/C-CLI-05)
- **Headless turns now survive real-CLI startup, resume, and teardown races.**
  Codex 0.153.3 can accept the 10-second fallback paste into its cold-start
  placeholder, swallow it during a later boot repaint, and appear to finish an
  empty turn; ergonomic turns now require positive submission evidence, replay
  an unaccepted prompt at most twice, and fail explicitly instead of reporting
  false success. A resumed Claude turn no longer treats its stale composer as
  an immediate end before real work paints. The headless owner also ignores
  transient attention from trust prompts it is already authorized to answer,
  and macOS teardown retries the short-lived post-exit `EPERM` process-group
  window instead of surfacing `cleanup_failed`. (§5.3/§5.8/§12A, C-API-48,
  C-TURN-03, C-CLI-05/09)
- **Claude model switches now complete through model/effort cache warnings.**
  Claude 2.1.258 may interpose `Switch model?` or `Change effort level?` after
  Elwood applies a session-only picker choice; Elwood previously treated that
  dialog as successful picker closure and returned while the session was still
  waiting. Elwood now recognizes numbered and unnumbered variants, navigates
  from the rendered cursor to the affirmative action, confirms the built-in
  cache warning, and waits for the idle composer before resolving `setModel`.
  Recognition is scoped to the bottom-most live dialog and revalidated before
  Enter, so transcript text cannot spoof a cache warning or composer. Hook-requested
  `PreModelSwitch` confirmations remain blocking and human-controlled. (§5.3,
  C-API-24/C-ATTN-04)
- **Concurrent Codex starts no longer race global npm updates.** Codex's live
  update dialog is now input-blocking until its rendered frame clears, so queued
  persona/caller input cannot press Enter on the default "Update now" action when
  a prompt layout is partial or drifts. Elwood still skips every recognized safe
  option automatically. Separately, `autoupdate` now holds an atomic per-user,
  per-adapter cross-process lease around the global updater; another Elwood host
  waits asynchronously, skips its duplicate install, and validates the resulting
  binary. The lease uses a stable account cache across differing `TMPDIR` values,
  records its owner/generation so live or successor updates cannot be evicted,
  and recovers dead owners safely. Failed partial installs also invalidate version
  and capability caches before validation. Coal Harbor and other consumers need
  no API or configuration changes. (§5.5/§9.2, C-CODEX-12/C-PERF-04/C-LIFE-09)
- **Claude's current cursor-style workspace trust prompt is auto-approved again.**
  Claude 2.1.252 replaced the older numbered, affirmative-first layout with an
  unnumbered menu that defaults to `No, exit`; the responder recognized its header
  but found no numbered affirmative, wrote nothing, and the readiness fallback
  could report `ready` over the still-visible gate. Elwood now supports both
  layouts, navigates cursor menus to the affirmative before Enter, keeps their
  entire option region out of header recognition, and verifies the real trust
  screen clears before readiness. The gate remains independent of Claude's
  `bypassPermissions` / `--dangerously-skip-permissions` policy. (§5.1/§5.3,
  C-CLAUDE-10/C-CLAUDE-14/C-E2E-09)
- **Modern Codex final replies now carry their text on `assistant_message`
  activity.** Codex 0.149.1 writes replies as assistant `message` response items
  with `phase: "final_answer"` and `content[].output_text`; Elwood previously
  expected a plain string (or a legacy `agent_message` duplicate), so consumers
  received a textless event and could silently discard the reply. Elwood now
  extracts the full final-answer text—including `@mentions`—while keeping
  commentary and user/developer transcript records out of assistant activity.
  (§5.4/§7A.4, C-API-12/C-CODEX-16)
- **Claude's `Not logged in · Run /login` sign-out is now detected mid-session.**
  A ready Claude session that gets logged out mid-run renders `Not logged in`
  (paired with a `run /login` hint) — a different wording than the `Login expired`
  / `Session expired` / `OAuth token revoked` banners Elwood already recognized.
  That form previously went undetected mid-session, so no `login_expired` warning
  fired. It now surfaces the same content-free `login_expired` warning (+ `warning`
  activity), leaving the session alive to recover via `session.login()`. (§5.3/§5.7,
  C-CLAUDE-17/18)
- **Codex's in-TUI update prompt is now re-skipped on the restart loop.** Elwood
  always skips Codex's interactive "update available" prompt (it never selects
  "Update now"; the real update is the `autoupdate` preflight). The skip was latched
  once per session, so if Codex restarted and the SAME update screen reappeared — the
  update did not take — the session got stuck looping on it. The skip is now
  edge-triggered: it re-arms when the update screen leaves the frame and re-skips the
  reappearance. (§5.5, C-CODEX-12)
- **Autoupdate is now best-effort and never fails a start on its own.** When
  `autoupdate: true` and `claude update` / `codex update` fails (a flaky network,
  a partial native-installer download, contention during a fleet launch), Elwood no
  longer rejects `startClaude`/`startCodex` with `claude_update_failed` /
  `codex_update_failed`. If the INSTALLED CLI still meets the minimum version, the
  session starts from it and Elwood emits a live `agent_update_failed` warning (safe
  diagnostics only: installed version, an allowlisted error code, bounded stderr).
  Startup fails only when the installed version is actually below the minimum. The
  warning is zero-burden — a consumer that does not subscribe to `warning` is
  unaffected and the session still reaches `ready`. (§9.2, C-LIFE-11)
- **A failed shared update no longer poisons the process.** A once-per-process
  update/probe cache that rejected was retained and replayed, so one failed
  `claude update` could reject every concurrent roster start AND every later start
  until the process restarted. Cached probes (autoupdate, version read, capability
  detection) now never retain a rejected result: concurrent callers share one attempt
  and a later caller re-attempts rather than inheriting the failure. (§9.2,
  C-LIFE-09/11)

- Trust, update, and model-switch dialogs on current Claude and Codex releases
  are recognized and answered; unrecognized dialogs block instead of guessing.
- Hook payloads are measured identically on both sides of the bridge, and
  multibyte characters split across socket chunks are decoded correctly.
- Cleanup is retryable: a failed `stop` / `kill` / `teardown` never latches,
  and post-exit `stop` / `kill` reject with the typed `termination_failed`
  rather than a bare `Error`.
- Headed CLI runs restore the invoking terminal's input and keyboard modes.
- `startOrResumeClaude` / `startOrResumeCodex` forward `reasoningEffort` (and
  every other resume option) on the resume path; a resumed session no longer
  silently loses the requested effort.
- A hook event other than `Stop` arriving after `Stop` (for example
  `Notification` or `FileChanged`) no longer clears the turn-completeness
  oracle, so late assistant text cannot leak into the next `send` / `stream`
  turn.
- Codex sessions no longer emit a false `transcript_records_dropped`
  (`unread_backlog`) warning on every turn after roughly 256 turns; each `Stop`
  now reads the transcript with a bounded per-pass scan.
- `terminal:data` replay never begins with U+FFFD; the 128 KB replay buffer
  trims on a UTF-8 code-point boundary.
- `compact()` no longer sends a stray Enter when the `/compact` write resolves
  after the compact timeout has already rejected.
- `send` / `stream` bind a turn to the first event that carries a `turnId`
  (Codex) rather than the first event of any kind.
- A transcript truncation or rotation discards the old file's buffered partial
  line instead of gluing it onto the new file's first record.
- A `PostToolUse` handler returning `{}` is accepted as "no decision" instead of
  failing open with a spurious `invalid_response` `hookError`.
- The per-hook `timeout` written into generated Claude settings and Codex
  overrides is now `hookTimeoutMs` rounded up plus five seconds, so the CLI
  never kills a hook before Elwood's fail-open reply arrives.
- `ClaudeSession.login()` no longer accumulates abort listeners and pending
  promises over a long polling flow.
- Codex `setModel` restores `config.toml` atomically (temp file plus rename,
  symlink written through, mode preserved); a crash can no longer leave the
  user's config empty. When no `config.toml` existed before the switch, the
  `codex_default_model_persisted` warning now says the picker created the file
  and Elwood left it in place.
- `setModel` reports "Could not locate the picker cursor." (still
  `model_automation_failed`) when rows parse but no cursor is rendered.
- Session records and the loop sidecar are read without following symlinks and
  are rejected as `state_corrupt` unless they are private (`0600`) regular
  files owned by the current user. Socket homes are keyed on the resolved
  `stateDir`, so relative spellings of one state directory share one home.
- A loop cancelled before its submission rejects with the typed
  `loop_submission_failed` error (with `details.loopId`) instead of a bare
  `Error`.
- A CLI version or update probe that times out or overflows now kills its whole
  process group, so a grandchild cannot outlive the bound or pin the event
  loop.
- Hook-bridge decisions larger than about 64 KiB are no longer truncated on
  macOS.
- The node-pty spawn helper's executable bit is checked before it is set, and a
  failed `chmod` is tolerated on read-only installs.
- `elwood` structured error records emitted before an agent was selected report
  `agent: null` instead of a hard-coded `"codex"`; auto-detection probes both
  agents concurrently; a login shell that cannot run the probe fails with
  `no_agent_found` naming the shell and errno; adapter-option conflicts with an
  auto-detected agent say so and suggest `--agent <other>`; config write
  failures name the path and errno; text-mode error diagnostics are suppressed
  only when stderr has closed, not stdout.
