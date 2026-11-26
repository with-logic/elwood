/**
 * The checks the real-CLI unrecognized startup proofs share. Within 20 s of the CLI's first
 * output the session is `blocked` with the screen's attention and has reported the screen
 * once with the deadline label. It holds the message queued at start and has written
 * nothing to the screen (C-E2E-28, C-E2E-29, PRD §5.4, C-ATTN-09).
 */
// biome-ignore-all lint/suspicious/noMisplacedAssertion: Both proofs share these assertions.
import assert from "node:assert/strict";
import type { ElwoodAgentKind } from "../../src/index.ts";
import { type E2eSession, observeSession, waitFor } from "./helpers.ts";
import type { PtyRecord } from "./pty-record.ts";
import { isTerminalProtocolReply } from "./terminal-protocol-reply.ts";

/** The deadline is 10 s after the first frame; the rest is slack for a loaded host. */
const reportWithinMs = 20_000;

/** Assertion messages never print the screen, which can show account details or a key. */
export async function awaitStartupBlock(
  session: E2eSession,
  record: PtyRecord,
  sent: Promise<unknown>,
  expected: { readonly label: `${ElwoodAgentKind}-unrecognized-startup`; readonly screen: string },
) {
  const observed = observeSession(session);
  // A held send stays pending: neither submitted nor refused.
  const outcome: { current: "pending" | "fulfilled" | "rejected" } = { current: "pending" };
  void sent.then(
    () => {
      outcome.current = "fulfilled";
    },
    () => {
      outcome.current = "rejected";
    },
  );
  const report = await waitFor(
    () => observed.activities.find((event) => event.kind === "unrecognized_startup"),
    "the unrecognized startup report",
    60_000,
  );
  // Polling finds the report after it was emitted, so this bounds it from above.
  const reportedAt = Date.now();
  assert.equal(session.status, "blocked");
  const attention = observed.activities.filter((event) => event.kind === "attention");
  assert.deepEqual(
    attention.map((event) => event.label),
    [expected.label],
  );
  assert.equal(report.label, "initial_ready_deadline");
  assert.ok(report.text.includes(expected.screen), "the report holds the screen");
  const firstOutputAt = record.firstOutputAt ?? reportedAt;
  assert.ok(reportedAt - firstOutputAt <= reportWithinMs, "the screen was reported late");
  assert.ok(session.terminal.snapshot().text.includes(expected.screen), "the screen is still up");
  assert.equal(outcome.current, "pending", "the queued message is held");
  const input = () => record.writes.filter(({ data }) => !isTerminalProtocolReply(data));
  assert.deepEqual(input(), [], "nothing was written to the screen");
  return { observed, outcome, input };
}
