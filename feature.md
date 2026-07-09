# Elwood requests from the coal-harbor team

**Owner:** elwood engineer. Open, net-new work — by priority:

- **Request 7 (OPEN, P0):** `591b967` leaks the agent `hook-bridge.mjs` process
  tree on session close / app quit — see below. Coal-harbor has REVERTED to
  `d3e97ad` (commit `d0bb915`) until this is fixed; re-bump once teardown reaps
  the tree.
- **Request 8 (DONE, P1):** auto-answer the allowlisted trust-prompt family
  (folder/directory + skill/plugin/MCP + Codex hook trust) under a full-trust
  launch, via a table-driven `TrustPromptResponder`. Narrowed to an explicit
  allowlist (not "any first-run confirmation") per review. Hook trust (Elwood's
  own integration) answers regardless of autotrust; third-party trust is gated
  on autotrust. Sub-item confirmed: `sendMessage` already shares the race-free
  paste-then-Enter submit from `18ba87f`. See below.
- **Request 9 (OPEN, P1):** a Claude CLI ghost-text / autocomplete SUGGESTION is
  being forwarded as a real `assistant_message` (kind=`assistant_message`, from
  the `Stop` hook's `last_assistant_message`) — so an un-sent autocomplete line
  ("go ahead and open that PR") posts into the room as if the agent spoke it.
  See below.

---

# Request 7 (OPEN, P0): `591b967` leaks the hook-bridge process tree on teardown

**Symptom.** After the `591b967` bump, the app leaks the agent session's
`hook-bridge.mjs` process tree on quit: orphaned Electron processes running
`.../elwood/sessions/<id>/hook-bridge.mjs` survive `app.close()`, and the app's
quit hangs waiting on a child that is no longer reaped. Over repeated
launch/quit cycles the orphans accumulate and starve the machine.

**Decisive A/B.** e2e-real `§1.22` (chat-scroll-persist; does 3 real Electron
launch→quit cycles), run from an identical clean process baseline with ONLY the
vendored elwood differing:

| vendored elwood   | result                                                        |
| ----------------- | ------------------------------------------------------------- |
| `d3e97ad` (prior) | PASSES in **6.0s**                                            |
| `591b967` (bump)  | HANGS past 90s; leaves `hook-bridge.mjs` Electron procs alive |

**Likely area.** `591b967`'s changes are all in the session close / control-queue
path ("reject in-flight control ops on close", "hold FIFO for message submits").
Consistent with the graceful-shutdown path no longer invoking the
process-tree kill (`web-shutdown.ts` `killProcessTreeSync`) for the PTY child
whose descendants include the Claude-spawned `hook-bridge.mjs` — or rejecting
the close op before the tree-kill runs.

**Asked of elwood.** On session `kill()`/close and on web shutdown, reap the
FULL PTY process tree (incl. the CLI-spawned hook bridge) before resolving, and
ensure a close that rejects in-flight control ops still completes teardown.
A regression test: spawn → note the hook-bridge child pid → close → assert the
pid is gone.

**coal-harbor status.** Reverted to `d3e97ad` (`d0bb915`) so the shipped app
doesn't leak on quit. Will re-bump (and keep `591b967`'s wanted control-queue
fixes) once teardown reaps the tree.

---

# Request 8 (OPEN, P1): auto-answer all launch/trust prompts, not just workspace-trust

**Symptom.** An agent wedged at startup on a prompt asking whether it could
read/load a skill. Agents run with Claude `permissionMode: bypassPermissions`
(so tool-permission prompts are gone) AND `autotrust: true` — but `autotrust`
only recognizes the WORKSPACE-trust prompt (`workspace-trust.ts`:
`/trust this folder/i`). A skill/plugin/other startup-trust prompt is a
DIFFERENT gate that neither `bypassPermissions` nor the workspace-trust
responder answers, so the agent blocks. Coal-harbor never relays these prompts
into the chat, so a wedged agent is invisible — we NEVER want an agent waiting
on a prompt.

**Asked of elwood.** Under a full-trust launch (`autotrust`/the privileged
posture agents already start with), DETECT and auto-answer an **explicit
allowlist** of known Claude/Codex startup + trust prompts — enumerated by their
exact on-screen text with a defined outcome per prompt (workspace/directory
trust, skill-load, plugin-trust, MCP-trust) — not just "trust this folder".
Treat the trust-prompt responder as owning that allowlisted set, extensible as
the CLI adds new ones, rather than a single hard-coded regex. Do NOT blanket
auto-answer "any first-run confirmation": an open-ended match would silently
bypass a future CLI security gate for third-party code/config. Each new prompt is
added to the allowlist deliberately, specified in `PRD.md` with a conformance
test, and — for prompts that grant third-party code/config trust beyond the
workspace — gated on the caller's explicit full-trust policy rather than answered
unconditionally. (We don't have the exact skill-prompt wording to hand yet;
elwood captures each concrete prompt from the CLIs it drives before allowlisting
it.)

**Related:** the FIRST chat message to a freshly spawned agent occasionally
fills the agent's terminal but doesn't submit (had to press Enter manually);
not reproducible on demand → a paste-then-Enter race on the `sendMessage` path,
a sibling of the persona-first-prompt race elwood fixed in `18ba87f` (which
hardened the ready-QUEUE path, not `sendMessage`). Flagged for elwood to
confirm `sendMessage` shares the race-free submit; low confidence pending a
repro.

---

# Request 9 (OPEN, P1): ghost-text / autocomplete is forwarded as an `assistant_message`

**Symptom.** An agent posted a message into the chat room that it never actually
sent — the text was a Claude CLI **autocomplete / ghost-text suggestion** (e.g.
"go ahead and open that PR"), not a committed assistant turn. It arrived as a
normal `assistant_message` activity, so coal-harbor rendered + routed it as a
real reply.

**Likely area.** `assistant_message` activities from the Claude path are built
from the `Stop`/`SubagentStop` hook's `last_assistant_message` field
(`claude/session.ts` → `activityFromHook`). If the CLI populates that field (or
the rendered-frame observation picks up the composer) with a ghost-text
suggestion that the user hasn't submitted, elwood forwards it as though the
agent spoke it. Coal-harbor's boundary can't distinguish committed prose from a
suggestion — the text is identical — so the classification has to happen where
elwood knows provenance (the transcript vs. the live TUI frame vs. the hook
payload).

**Asked of elwood.** Only emit a Claude `assistant_message` for text that is a
COMMITTED assistant turn — sourced from the transcript / a real `Stop` payload —
never from ghost-text, an autocomplete suggestion, or an unsent composer draft
observed in the rendered frame. If the two can look alike at the hook boundary,
prefer the transcript as the source of truth for `assistant_message.text` (as
the Codex path already does) so an un-sent suggestion never becomes a room
message. A regression test: drive a ghost-text/autocomplete suggestion into the
CLI without submitting → assert NO `assistant_message` activity fires.

**coal-harbor status.** No local mitigation — a text-only heuristic can't
reliably tell a suggestion from real prose, and the room log must stay faithful.
Waiting on elwood to gate `assistant_message` on committed-turn provenance.
