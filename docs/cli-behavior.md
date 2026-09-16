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

## Readiness

**Codex fires its `SessionStart` hook lazily — on the first turn, not at boot.**
Any experiment that waits for a boot-time Codex hook *without running a turn* is
invalid and will conclude the hook "never fires". (This once produced a false
"CODEX_HOME disables hooks" claim, since retracted — Codex hooks work fine under
sandboxed homes, and user `config.toml` hooks merge additively with `-c` hooks.)
Because `SessionStart` is Elwood's authoritative Codex readiness signal
(`markInitialReadyFromHook`, `src/codex/session/hooks.ts`), cold-start readiness
comes from that hook, bounded by a **10 s starvation deadline** armed on the
first render frame (`src/runtime/readiness/initial-ready.ts`, `maxWaitMs = 10_000`). C-API-28.

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

## Codex transcript replies

**Codex 0.149.1 writes committed replies as phased `message` response items, not
`agent_message` items.** The assistant's commentary and final reply are separate
`response_item` records whose payloads use `type: "message"` and a `content[]`
array of `{ type: "output_text", text }` entries. Only the assistant record with
`phase: "final_answer"` is the committed room reply; `phase: "commentary"` is
progress narration, and user/developer message records are inputs. Current
sessions emit no legacy `agent_message` duplicate, so treating `content` as a
plain string silently drops the reply text. The transcript adapter therefore
extracts `output_text` only from assistant `final_answer` records while retaining
legacy string/`agent_message` support. C-CODEX-16.

## Model selection persistence

- **A configured legacy Codex model may be absent from `/model`.** On Codex
  0.154.0, `gpt-5.1-codex` still appeared in the session header but not in the
  visible catalog; every returned row correctly had `isCurrent: false`.
  Real picker tests should let the installed CLI choose its launch default,
  rather than pinning a model that can disappear from the catalog.
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
  (`❯ No, exit / Yes, I trust this folder`). Accepting requires ArrowDown + Enter;
  sending the old numeric answer leaves the dialog waiting.

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
  number or navigate from the rendered cursor to the affirmative and press Enter.

Under `autotrust`, detect-and-approve: if a trust prompt is detected, answer yes
rather than leave the agent hanging on the gate. Keep the cheap safety: never
select a destructive-rider affirmative, and never answer a specific-affirmative
prompt (e.g. hook trust) with a generic "Yes". `src/core/trust/responder.ts`,
`src/core/trust/prompts.ts`, verified by `tests/e2e/trust-prompt-claude.e2e.ts`.

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
once-per-machine. **Empirically, on 2.1.268 (Claude Max account, macOS) the
dialog did NOT render at all** — neither through Elwood's `--permission-mode
bypassPermissions` launch nor with a raw `--dangerously-skip-permissions`
launch — and no `bypassPermissionsModeAccepted` key existed anywhere under
`~/.claude*`; the session went straight to the composer with the persistent
`⏵⏵ bypass permissions on (shift+tab to cycle)` footer. Whether it appears is
therefore version/account-gated, and Elwood must be correct in BOTH states:

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

**Do not equate `autotrust` with “not blocking” until the write clears the real
screen.** Trust rules are omitted from human-blocking classification under
`autotrust`, because automation owns the gate. If option parsing drifts and writes
nothing, the 10 s initial-ready starvation deadline can otherwise report `ready`
over a still-visible trust dialog. C-E2E-09 therefore requires both `ready` and a
cleared trust screen; a complete but unanswerable real frame is a failure, not a
skip.

The responder emits one transient `attention` when a recognized header paints
before its affirmative option. A headless owner must ignore that transient only
when its trust policy already authorizes the exact allowlisted prompt; `--no-trust`
and generic permission dialogs remain human blocks. The startup replay buffer can
deliver this attention after the responder has already continued, so treating
every attention event as fatal produces a false `blocked_prompt`.

## Codex in-TUI update prompt (and the restart loop)

Independent of the `autoupdate` preflight (`codex update` run before spawn), the
Codex TUI can show its OWN "update available" prompt at launch. Elwood **always
skips it** — it never selects "Update now" — because letting the live TUI update
itself restarts Codex out from under the PTY session. The real update is the
preflight; the in-TUI prompt is a nuisance to dismiss.

**The trap (reported against the field, 2026-08):** an in-TUI update that a human
"accepts" (or that Elwood used to leave latched) restarts Codex, the update does
**not** take (a partial download, a managed install, contention), and the SAME
update screen returns — an infinite loop stuck on the update screen. The fix is an
**edge-triggered** skip: skip once per appearance, and RE-ARM the moment the update
screen leaves the frame, so a reappearance after the restart is skipped again
rather than sitting latched forever. Edge-detection mirrors the login watcher.

Two version-coupled wrinkles this cost us:

- The skip-attempt is gated by a per-session prompt tracker, even though the
  option is located in the accumulated buffer. Codex can split the distinctive
  versioned banner and its options across consecutive screen replacements; once
  the banner activates the tracker, a safe-option-only continuation remains the
  same blocking prompt. A definite non-update frame clears it. Matching the
  accumulated buffer alone lets benign later prose re-fire against a **stale
  buffered option** — a real bug we hit while building this. C-CODEX-12.
- Option labels drift by version. Older codex (0.132/0.133) rendered a numbered
  dialog ("1. Update now / 2. Skip / 3. Skip until next version"). In the installed
  0.149.1 binary, the upgrade notice strings extracted from the native binary read
  like a **passive banner** (`<version> to update.` +
  `https://github.com/openai/codex for installation options.`) rather than a
  numbered dialog — so the interactive dialog is not guaranteed on every version.
  The skip is written ONLY when a numbered skip option is actually present
  (`findNumberedOption` → null ⇒ no write), so a passive banner is a harmless no-op.
  Every retry revalidates that the frame still belongs to the captured first-party
  update-prompt generation and uses the safe option's current number. This preserves
  the known safe-option-only continuation layout without letting a cleared/reappeared
  prompt or replacement dialog inherit a stale digit. A prompt that remains blocking
  but cannot be safely answered becomes `blocked_prompt` after the bounded
  responder/grace window, including runs without a whole-invocation timeout.
  The match set (`src/codex/update-prompt.ts`) is unit-tested against captured
  layouts, NOT against a live update event (which requires an actually-stale binary
  to trigger). If Codex changes the dialog wording, this is the first thing to
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
now" and a safe skip/later choice are present. Once active, a safe-option-only
continuation stays latched until a definite non-update frame. Generic agent prose
containing "update available" and the actual 0.149.1 passive installation notice
do not block.

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

## Input / paste

- Caller and LLM text sent via `sendPrompt`/`sendMessage`/`sendGuidance` is
  sanitized (`sanitizePasteText`, `src/core/input/index.ts`): it strips
  bracketed-paste markers (`ESC[200~`/`ESC[201~`) and C0/C1 controls except
  tab/nl/cr, so text can't escape bracketed paste and inject a dialog-confirming
  Enter. C-API-40.
- A submission's Enter is **held while a blocking dialog is visible**
  (`waitWhileBlocked`), so a dialog appearing in the paste→Enter window can't be
  auto-confirmed by the pending Enter.
- **Writing a literal ESC byte in source is fragile** — it can be silently
  stripped by an editor/pipeline (this once neutered an interrupt e2e). Always
  write the escape sequence form (``), never a raw ESC character.

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
  on the current rendered frame; once it disappears, no delayed key can reach the
  composer. Some PTY hosts close their input side before process completion and
  then return `EIO` from `setRawMode(false)`; contain only terminal-gone restoration
  errors because that host is already the sole remaining terminal-mode owner.
- Interactive login-shell probes can give their external command control of the
  caller's real terminal, then exit without restoring its foreground process group.
  A headed run subsequently restoring cooked mode is stopped by `SIGTTOU` before its
  defensive VT reset, leaving terminal query replies to leak into the resumed shell.
  Run probes in a detached process session so they keep interactive PATH resolution
  without participating in the caller terminal's job control.
- Current agent TUIs push Kitty keyboard enhancements with `CSI > flags u`. Head mode
  stops mirroring before agent teardown, so it cannot rely on the agent's matching
  cleanup sequence reaching the physical terminal. The defensive reset must emit
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
  catch up after ready") and floods `transcript_read_error (ENOENT)`. The e2e
  helper strips those variables; do the same for manual smoke runs.
- Even outside nesting, one `transcript_read_error (ENOENT)` warning appears at
  Claude startup before the first turn creates the transcript file. It is
  pre-existing run behavior, not specific to `models`.

`elwood sessions` reports `live` from the presence of a `.sock` file in the
session's stable socket home. A connect probe was rejected on purpose: the
bridge treats any connection that closes without a frame as a malformed request
and emits `hookError`/`activity` on the live owner, so presence is the only
side-effect-free signal. C-CLI-21 through C-CLI-24.

## Testing against the real CLIs

- `test:e2e` runs **serially** (`--test-concurrency=1`): Codex config-file
  persistence means parallel test files contaminate each other's `config.toml`.
- The picker/screen parsers are pinned to specific CLI screen layouts (versions
  noted in the fixtures). Layout drift fails loudly rather than silently
  mis-parsing, except where only marker semantics changed.
- Per the testing pyramid in `CLAUDE.md`: anything that interfaces with the real
  CLI SHOULD have a real-CLI e2e. Every fact in this file is one a unit test could
  not have caught.
