/**
 * Claude's `InstructionsLoaded` readiness waits for PTY output Claude has sent to render,
 * including its first output and an open synchronized update. After a render failure it
 * no longer waits (PRD §5.3, C-API-28).
 */
import { afterEach, expect, test, vi } from "vitest";
import { type ClaudeSessionApi, type ElwoodSessionStatus, startClaude } from "../../src/index.ts";
import { claudeComposer, claudeTty } from "../fixtures/trust-composer.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

const sessions: ClaudeSessionApi[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(sessions.splice(0).map((session) => session.teardown()));
  resetFakes();
});

const beginSync = "\u001b[?2026h";
const endSync = "\u001b[?2026l";
const clear = "\u001b[2J\u001b[H";
const composer = `${clear}${claudeTty(claudeComposer)}`;
const approval = `${clear}Do you want to create elwood.txt?\r\n❯ 1. Yes\r\n  3. No\r\nEsc to cancel`;
const queued = ["\u001b[200~queued text\u001b[201~", "\r"];

/** A started session with a message queued, before any output or readiness hook. */
async function startWithQueuedMessage() {
  installFakes();
  const cwd = tempDir();
  const session = await startClaude({ cwd });
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
  const instructionsLoaded = () =>
    ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "InstructionsLoaded",
      session_id: "claude-1",
      cwd,
      file_path: "/tmp/CLAUDE.md",
      memory_type: "Project",
      load_reason: "session_start",
    });
  return { session, statuses, sent, paint, instructionsLoaded, writes: ptys[0]!.writes };
}

test("C-API-28 Claude's readiness hook waits for its first output to render", async () => {
  const { session, statuses, sent, instructionsLoaded, writes } = await startWithQueuedMessage();
  ptys[0]!.emitData(approval);
  // Handed to the terminal, but not drawn yet.
  const drawn = session.terminal.settled();
  await instructionsLoaded();
  expect(statuses).toEqual([]);
  // Rendered, the first frame is a dialog, which holds the queue.
  await vi.advanceTimersByTimeAsync(2_000);
  await drawn;
  expect(statuses).toEqual(["blocked"]);
  expect(writes).toEqual([]);
  ptys[0]!.emitData(composer);
  await vi.advanceTimersByTimeAsync(500);
  await sent;
  expect(writes).toEqual(queued);
  expect(statuses).toEqual(["blocked", "ready", "running"]);
});

test("C-API-28 Claude's readiness hook during a repaint waits, and a dialog it draws holds the queue", async () => {
  const { statuses, sent, paint, instructionsLoaded, writes } = await startWithQueuedMessage();
  await paint(composer);
  ptys[0]!.emitData(`${beginSync}${approval}`);
  await instructionsLoaded();
  expect(statuses).toEqual([]);
  await paint(endSync);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(statuses).toEqual(["blocked"]);
  expect(writes).toEqual([]);
  await paint(composer);
  await vi.advanceTimersByTimeAsync(500);
  await sent;
  expect(writes).toEqual(queued);
  expect(statuses).toEqual(["blocked", "ready", "running"]);
});

test("C-API-28 Claude's readiness hook during an open synchronized update marks once it ends", async () => {
  const { statuses, sent, paint, instructionsLoaded, writes } = await startWithQueuedMessage();
  await paint(composer);
  await paint(beginSync);
  await instructionsLoaded();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(statuses).toEqual([]);
  expect(writes).toEqual([]);
  await paint(endSync);
  await vi.advanceTimersByTimeAsync(500);
  await sent;
  expect(writes).toEqual(queued);
  expect(statuses).toEqual(["ready", "running"]);
});

test("C-API-28 after a render failure, Claude's readiness hook still marks readiness", async () => {
  const { session, statuses, paint, instructionsLoaded, writes } = await startWithQueuedMessage();
  await paint(composer);
  vi.spyOn(session.terminal.xterm, "write").mockImplementationOnce(() => {
    throw new Error("render failed");
  });
  ptys[0]!.emitData("\r\nlost");
  await vi.advanceTimersByTimeAsync(10);
  expect(session.terminal.renderFailed).toBe(true);
  await instructionsLoaded();
  await vi.advanceTimersByTimeAsync(500);
  // The queue releases, but its write stays withheld: the screen can no longer be
  // vouched for (C-API-56).
  expect(statuses).toEqual(["ready", "running"]);
  expect(writes).toEqual([]);
});
