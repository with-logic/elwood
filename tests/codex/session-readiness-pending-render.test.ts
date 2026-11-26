/**
 * Initial readiness waits for output Codex has sent to render: a repaint in progress can
 * replace the configured composer Elwood last rendered, so neither the deadline nor a
 * readiness hook marks on that composer (PRD §5.3, C-API-28, C-ATTN-09).
 */
import { afterEach, expect, test, vi } from "vitest";
import { type CodexSessionApi, type ElwoodSessionStatus, startCodex } from "../../src/index.ts";
import { codexComposer, codexTty } from "../fixtures/trust-composer.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

const sessions: CodexSessionApi[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(sessions.splice(0).map((session) => session.teardown()));
  resetFakes();
});

const beginSync = "\u001b[?2026h";
const endSync = "\u001b[?2026l";
/** A screen no rule recognizes, with an Enter default. */
const unknownPrompt =
  "  Pick an option\r\n\r\n› 1. Yes, continue\r\n  2. No, quit\r\n\r\n  Press enter to continue";
const approval =
  "Would you like to run the following command?\r\n› 1. Yes\r\n  2. No\r\nPress enter to confirm or esc to cancel";
const queued = ["\u001b[200~queued text\u001b[201~", "\r"];

/** A session on its configured composer, with a message queued, before any readiness hook. */
async function onComposer() {
  installFakes();
  const cwd = tempDir();
  const session = await startCodex({ cwd });
  sessions.push(session);
  const statuses: ElwoodSessionStatus[] = [];
  session.on("status", ({ status }) => statuses.push(status));
  // The startup warning gate opens on a real timer before this test takes over the clock.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  vi.useFakeTimers();
  const sent = session.sendMessage("queued text");
  void sent.catch(() => {});
  const paint = async (data: string) => {
    ptys[0]!.emitData(data);
    const settled = session.terminal.settled();
    await vi.advanceTimersByTimeAsync(0);
    await settled;
  };
  await paint(`\u001b[2J\u001b[H${codexTty(codexComposer)}`);
  return { session, cwd, statuses, sent, paint, writes: ptys[0]!.writes };
}

test("C-API-28 the deadline does not mark on a composer that a repaint in progress replaces", async () => {
  const { statuses, paint, writes } = await onComposer();
  await vi.advanceTimersByTimeAsync(9_999);
  ptys[0]!.emitData(`${beginSync}\u001b[2J\u001b[H${unknownPrompt}`);
  await vi.advanceTimersByTimeAsync(1);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(writes).toEqual([]);
  expect(statuses).toEqual([]);
  // Rendered, the screen is one Elwood does not recognize, and it blocks (C-ATTN-09).
  await paint(endSync);
  expect(statuses).toEqual(["blocked"]);
  expect(writes).toEqual([]);
});

test("C-API-28 a readiness hook during a repaint waits for it, and a dialog it draws holds the queue", async () => {
  const { session, cwd, statuses, sent, paint, writes } = await onComposer();
  await vi.advanceTimersByTimeAsync(5_000);
  ptys[0]!.emitData(`${beginSync}\u001b[2J\u001b[H${approval}`);
  await becomeReady(session.elwoodSessionId, cwd);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(writes).toEqual([]);
  await paint(endSync);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(writes).toEqual([]);
  expect(statuses).not.toContain("ready");
  // The dialog answered, the composer releases the message once.
  await paint(`\u001b[2J\u001b[H${codexTty(codexComposer)}`);
  await vi.advanceTimersByTimeAsync(500);
  await sent;
  expect(writes).toEqual(queued);
});
