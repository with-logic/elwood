# Validate-review: intentionally-accepted / deferred findings

After the round-2 review and four validate-review remediation passes, four
findings remain that validate-review reports as partial/not-addressed. Each is
an explicit decision or a structural fact, NOT a latent bug. Recorded here so the
disposition is on the record before proceeding to the next code-review round.

## 1. "Prompt-region parsing crosses the blank-line trust boundary" — ACCEPTED (WONTFIX; stale comments reconciled)

The frame `Do you trust this folder?\n\nDelete stored credentials\n1. Yes, proceed`
auto-answers `1`. This is the direct, intended consequence of the product
directive: **never leave an agent waiting on a trust gate — under autotrust, say
yes to any recognized allowlisted trust prompt.** The trust responder was
deliberately simplified to that policy (commit 46f8e06); PRD §5.1 and C-CODEX-15
were rewritten to match. The remaining guards are: (a) only ALLOWLISTED prompts
are auto-answered, and (b) a prompt is recognized only by its HEADER wording on a
non-option line, so an option-only phrase cannot spoof one. The stacked
trust-prompt-over-credentials-dialog frame does not occur in a real single-dialog
Claude/Codex render. validate-review is security-strict and will not pass this;
the runtime decision stands.

Round-3 review re-flagged this and additionally noted that some comments/tests
still CLAIMED region isolation that the implementation intentionally does not
have. That secondary point WAS fixed: the stale "region isolation is still
enforced" / "destructive rider" comments in `tests/unit/trust-responder-security.test.ts`
and `tests/unit/trust-responder.test.ts` were rewritten to state accurately that
recognition is the ONLY guard and there is no region isolation by design. The
type-safety of the trust/startup surface was also tightened (findings 2/12) so
invalid trust ids and impossible agent/label pairings are now unrepresentable —
without changing the "say yes" runtime behavior.

## 2. "Prompt tests use invented strings, not captured CLI frames" — PARTIALLY ACCEPTED

The highest-value case — the real claude 2.1.206 folder-trust frame that actually
caused the wrapped-header regression — IS captured and pinned (C-E2E-09 +
tests/unit/trust-responder.test.ts). Skill/plugin/MCP trust prompts are hard to
trigger deterministically in headless e2e; the e2e skips loudly if no live frame
renders. Diminishing returns to capture the rest.

## 3. "C-LIFE-11 exercises a queued message, not an in-flight operation" — STRUCTURAL

`sendMessage` resolves the instant it writes to the PTY, so it cannot be pending
in-flight at teardown. The two operations that genuinely CAN be in-flight
(`compact`, `setModel`) are covered by session-teardown-inflight.test.ts. There is
no in-flight `sendMessage` branch to test.

## 4. "One scan can synchronously process 16 MiB per cursor" — ADEQUATELY BOUNDED

The normal-scan path now shares a watcher-wide ~4 MiB budget across all cursors,
and the terminal drain (retire/finish) is capped by maxDrainChunks. The reviewer
additionally wants fully async/yielding reads; that is a substantial rewrite of a
path that is already bounded, and is deferred as diminishing returns.

## 5. Round-3: "A trust header can authorize another dialog's affirmative option" — WONTFIX (policy)

validate-review round 3 keeps this as "not addressed" and reproduces a stacked
`Do you trust this folder?` + `Delete stored credentials?` frame being answered.
This is the DIRECT, intended consequence of Steve's standing directive — "never
block an agent on a trust prompt; say yes to any recognized allowlisted prompt"
— and cannot be "fixed" without re-introducing the region-scoping the directive
overrode. What WAS actionable and is now done: the PRD is internally consistent
(§5.1 and C-CLAUDE-14 both describe first-affirmative, recognition-is-the-only-
guard, no region binding), and the stale comments/tests that had claimed region
isolation were corrected. The security-strict validator will never pass a
say-yes policy; the runtime decision stands by explicit user instruction.

## 6. Round-3: "Exit/retirement synchronously drain up to 256 MiB per cursor" — BOUNDED-LATENCY (accepted)

The original unbounded per-cursor 1024-chunk (~256 MiB) synchronous drain is
gone: retire() and finish() now share ONE watcher-wide terminal budget (256
chunks ≈ 64 MiB total for the whole watcher lifetime, never a fresh budget per
retire) AND each drain call stops at a 50 ms wall-clock slice, accounting any
leftover backlog as a content-free drop. The reviewer additionally wants fully
async `setImmediate`-yielding retire/finish. That was deliberately NOT done: it
breaks the synchronous-caller ordering contract C-LIFE-10 depends on (terminal:exit
must not await the flush) and would force edits to lifecycle/recovery tests mid-
teardown. The PRD wording was corrected from "non-blocking" to "bounded-latency"
to describe the real guarantee (a bounded 50 ms slice, not zero blocking).

## 7. Round-4: real-CLI capture of skill/plugin/MCP trust gates — ACCEPTED BOUNDARY

Round-4 re-raised that only folder-trust is captured live; skill/plugin/MCP
allowlist entries use hand-authored frames. These gates are hard to trigger
deterministically in headless e2e (they need a real skill/plugin/MCP install
flow), and the highest-value case (the real folder-trust frame that caused the
wrapped-header regression) IS pinned. The e2e skips loudly if no live frame
renders. This remains the earlier "diminishing returns" decision (item 2) and is
unchanged — the option-only anti-spoof guard now also protects the BLOCKING
classification path (round-4 finding fixed), which was the concrete risk.

## 8. Round-4: full-public-session teardown-leak e2e — ACCEPTED BOUNDARY (covered by seam + real-tree tests)

Round-4 wants a real session started through the public API, its process tree
recorded, torn down via the public lifecycle, and the tree proven gone. The
public session intentionally does NOT expose its PTY pid (encapsulation), so a
black-box tree-liveness assertion would need either a new test-only pid accessor
or an agent-cooperation marker (flaky). The reap correctness IS covered two ways:
`reap-tree-real.test.ts` starts a REAL PTY tree with a grandchild reparented to
PID 1 and proves `reapProcessGroup` kills it; and the round-4 lifecycle work adds
session-level tests that the reap RUNS on every teardown path (unsolicited exit,
explicit stop/kill, already-terminal) with injected fake killers — including that
a throwing transcript/status listener still reaches the reap. Adding a flaky
black-box tree e2e for the seam already proven is deferred as diminishing returns.
