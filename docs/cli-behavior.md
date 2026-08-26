# Hard-Won CLI Behavior Notes

Elwood drives the real Claude and Codex CLIs through a PTY. Those CLIs have
undocumented, version-coupled behaviors that repeatedly cost debugging time —
and that a green unit suite at 100% coverage does **not** catch, because they
only surface against the real CLI. This file records what we learned empirically
so the next engineer or agent does not rediscover it the hard way.

Each fact below was verified against a real CLI (versions noted where relevant).
When a fact drives an implementation decision, the code and the matching PRD
conformance criterion are cited. If you change behavior here, update `PRD.md`
first (see `CLAUDE.md` / `AGENTS.md`), then this file.

## Readiness

**Codex fires its `SessionStart` hook lazily — on the first turn, not at boot.**
Any experiment that waits for a boot-time Codex hook *without running a turn* is
invalid and will conclude the hook "never fires". (This once produced a false
"CODEX_HOME disables hooks" claim, since retracted — Codex hooks work fine under
sandboxed homes, and user `config.toml` hooks merge additively with `-c` hooks.)
Because `SessionStart` is Elwood's authoritative Codex readiness signal
(`markInitialReadyFromHook`, `src/codex/session-hooks.ts`), cold-start readiness
comes from that hook, bounded by a **10 s starvation deadline** armed on the
first render frame (`src/runtime/initial-ready.ts`, `maxWaitMs = 10_000`). C-API-28.

**Claude re-fires `InstructionsLoaded`/`SessionStart` on resume; Codex does
not.** So a resumed Claude session reaches ready fast via its hook, while a
resumed Codex session would otherwise wait out the full 10 s deadline (the
conversation already exists, so no `SessionStart` re-fires). To avoid that, on
**resume only**, Elwood also accepts the rendered composer as a readiness signal
(`createReadinessGate(onReady, resumed)`, `src/runtime/session-readiness.ts`).

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
the live session object. The persisted `session.json` holds ONLY what resume
needs (adapter, cwd, per-adapter resumeId + launch posture); it carries **no
status or timing at all**, so there is nothing there to poll for readiness.
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

- **Codex persists `/model` picker selections into the user `config.toml`.**
  `setModel` restores the prior default via compare-and-swap after switching
  (C-CODEX-14), skipping with a `codex_default_model_persisted` warning on a
  concurrent external edit.
- **Claude number keys in its picker instantly persist the user default** — never
  send them. Claude's `s` selection is session-only.

## Trust prompts

The real Claude folder-trust prompt renders as **one dialog** spanning
header → blank line(s) → descriptive prose → options, and the header question
**wraps across physical rows** on a narrow terminal. A matcher MUST:

- match against the dialog's **joined** non-option lines, never line-by-line, and
  never treat a blank line as a dialog boundary;
- anchor on a non-option **header** line whose pattern matches the question
  wording — an option-only phrase (e.g. "trust this folder", which appears in the
  "Yes" option) must never anchor a prompt (anti-spoofing).

Under `autotrust`, detect-and-approve: if a trust prompt is detected, answer yes
rather than leave the agent hanging on the gate. Keep the cheap safety: never
select a destructive-rider affirmative, and never answer a specific-affirmative
prompt (e.g. hook trust) with a generic "Yes". `src/core/trust-responder.ts`,
`src/core/trust-prompts.ts`, verified by `tests/e2e/trust-prompt-claude.e2e.ts`.

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

- The skip-attempt is gated on the **current frame** still showing the update
  screen (its banner OR a numbered skip option), even though the option is located
  in the accumulated buffer (Codex can split the banner and its options across two
  consecutive frames). Gating the *attempt* on the buffer alone means a re-armed
  benign frame that merely says "update" re-fires a skip against a **stale buffered
  option** — a real bug we hit while building this. `src/codex/startup-prompts.ts`,
  `currentFrameShowsUpdatePrompt`, C-CODEX-12.
- Option labels drift by version. Older codex (0.132/0.133) rendered a numbered
  dialog ("1. Update now / 2. Skip / 3. Skip until next version"). In the installed
  0.149.1 binary, the upgrade notice strings extracted from the native binary read
  like a **passive banner** (`<version> to update.` +
  `https://github.com/openai/codex for installation options.`) rather than a
  numbered dialog — so the interactive dialog is not guaranteed on every version.
  The skip is written ONLY when a numbered skip option is actually present
  (`findNumberedOption` → null ⇒ no write), so a passive banner is a harmless no-op.
  The match set (`updateOptionPattern`, `updateScreenBanner`) is unit-tested against
  captured layouts, NOT against a live update event (which requires an actually-stale
  binary to trigger). If Codex changes the dialog wording, this is the first thing
  to re-capture.

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
  sanitized (`sanitizePasteText`, `src/core/session-input.ts`): it strips
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

## Testing against the real CLIs

- `test:e2e` runs **serially** (`--test-concurrency=1`): Codex config-file
  persistence means parallel test files contaminate each other's `config.toml`.
- The picker/screen parsers are pinned to specific CLI screen layouts (versions
  noted in the fixtures). Layout drift fails loudly rather than silently
  mis-parsing, except where only marker semantics changed.
- Per the testing pyramid in `CLAUDE.md`: anything that interfaces with the real
  CLI SHOULD have a real-CLI e2e. Every fact in this file is one a unit test could
  not have caught.
