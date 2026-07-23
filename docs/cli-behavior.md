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
the live session object. The persisted `session.json` is internal resume state;
its status/timing lags, may relocate, and is not part of the readiness contract.
`statusDecisions()` is **live-only, per-instance, never persisted** — on resume
it is empty at t=0, so `statusDecisions().some(d => d.to === "ready")` is not a
valid "has this conversation ever been ready" derivation. (Both mistakes were
real consumer bugs misattributed to a CLI regression.)

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

## Testing against the real CLIs

- `test:e2e` runs **serially** (`--test-concurrency=1`): Codex config-file
  persistence means parallel test files contaminate each other's `config.toml`.
- The picker/screen parsers are pinned to specific CLI screen layouts (versions
  noted in the fixtures). Layout drift fails loudly rather than silently
  mis-parsing, except where only marker semantics changed.
- Per the testing pyramid in `CLAUDE.md`: anything that interfaces with the real
  CLI SHOULD have a real-CLI e2e. Every fact in this file is one a unit test could
  not have caught.
