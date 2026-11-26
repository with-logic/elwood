/**
 * Initial readiness waits for PTY output Codex has sent to render, including an open
 * synchronized update: a repaint in progress can replace the configured composer Elwood
 * last rendered, so neither the deadline nor a readiness hook marks on that composer.
 * Host output does not delay it (PRD §5.3, C-API-28).
 */
import { afterEach, expect, test, vi } from "vitest";
import { type CodexSessionApi, type ElwoodSessionStatus, startCodex } from "../../src/index.ts";
import { ptyOutputPending } from "../../src/terminal/cursor.ts";
import { unrecognizedStartupScreen } from "../fixtures/codex-unrecognized-startup.ts";
import { codexComposer, codexTty, tty } from "../fixtures/trust-composer.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

const sessions: CodexSessionApi[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(sessions.splice(0).map((session) => session.teardown()));
  resetFakes();
});

const beginSync = "\u001b[?2026h";
const endSync = "\u001b[?2026l";
const clear = "\u001b[2J\u001b[H";
const unrecognized = `${clear}${tty(unrecognizedStartupScreen)}`;
const approval =
  "Would you like to run the following command?\r\n› 1. Yes\r\n  2. No\r\nPress enter to confirm or esc to cancel";
/** Codex 0.164.0's boot composer: a composer, but not a configured session's. */
const boot = capturedFrame("codex-0.164.0/boot/boot-composer").trimEnd();
const composer = `${clear}${codexTty(codexComposer)}`;
const queued = ["\u001b[200~queued text\u001b[201~", "\r"];

/** A session on its configured composer, with a message queued, before any readiness hook. */
async function startOnConfiguredComposer() {
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
  await paint(composer);
  return { session, cwd, statuses, sent, paint, writes: ptys[0]!.writes };
}

test("C-API-28 the deadline does not mark on a composer that a repaint in progress replaces", async () => {
  const { session, statuses, paint, writes } = await startOnConfiguredComposer();
  await vi.advanceTimersByTimeAsync(9_999);
  ptys[0]!.emitData(`${beginSync}${unrecognized}`);
  await vi.advanceTimersByTimeAsync(1);
  // The deadline fell while the repaint was still staged for rendering.
  expect(ptyOutputPending(session.terminal)).toBe(true);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(writes).toEqual([]);
  expect(statuses).toEqual([]);
  // Rendered, the screen shows no configured composer, so nothing marks or writes.
  await paint(endSync);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(statuses).toEqual([]);
  expect(writes).toEqual([]);
});

test("C-API-28 the deadline waits for a configured composer when a repaint replaces it with the boot composer", async () => {
  const { session, sent, statuses, paint, writes } = await startOnConfiguredComposer();
  await vi.advanceTimersByTimeAsync(9_999);
  ptys[0]!.emitData(`${beginSync}${clear}${tty(boot)}`);
  await vi.advanceTimersByTimeAsync(1);
  expect(ptyOutputPending(session.terminal)).toBe(true);
  await paint(endSync);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(writes).toEqual([]);
  expect(statuses).toEqual([]);
  await paint(composer);
  await vi.advanceTimersByTimeAsync(500);
  await sent;
  expect(writes).toEqual(queued);
  expect(statuses).toEqual(["ready", "running"]);
});

test("C-API-28 the deadline waits for an open synchronized update to end", async () => {
  const { session, sent, statuses, paint, writes } = await startOnConfiguredComposer();
  await vi.advanceTimersByTimeAsync(9_999);
  // Rendered, the update's start leaves the composer drawn, but more of it is to come.
  await paint(beginSync);
  expect(ptyOutputPending(session.terminal)).toBe(false);
  expect(session.terminal.xterm.modes.synchronizedOutputMode).toBe(true);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(writes).toEqual([]);
  expect(statuses).toEqual([]);
  await paint(endSync);
  await vi.advanceTimersByTimeAsync(500);
  await sent;
  expect(writes).toEqual(queued);
  expect(statuses).toEqual(["ready", "running"]);
});

test("C-API-28 a readiness hook during a repaint waits for it, and a dialog it draws holds the queue", async () => {
  const { session, cwd, statuses, sent, paint, writes } = await startOnConfiguredComposer();
  await vi.advanceTimersByTimeAsync(5_000);
  ptys[0]!.emitData(`${beginSync}${clear}${approval}`);
  await becomeReady(session.elwoodSessionId, cwd);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(writes).toEqual([]);
  await paint(endSync);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(writes).toEqual([]);
  expect(statuses).toEqual(["blocked"]);
  // The dialog answered, the composer releases the message once.
  await paint(composer);
  await vi.advanceTimersByTimeAsync(500);
  await sent;
  expect(writes).toEqual(queued);
  expect(statuses).toEqual(["blocked", "ready", "running"]);
});

test("C-API-28 a readiness hook during an open synchronized update marks once it ends", async () => {
  const { session, cwd, statuses, sent, paint, writes } = await startOnConfiguredComposer();
  await paint(beginSync);
  await becomeReady(session.elwoodSessionId, cwd);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(writes).toEqual([]);
  expect(statuses).toEqual([]);
  await paint(endSync);
  await vi.advanceTimersByTimeAsync(500);
  await sent;
  expect(writes).toEqual(queued);
  expect(statuses).toEqual(["ready", "running"]);
});

test("C-API-28 host output written to the terminal does not delay readiness", async () => {
  const { session, sent, statuses, writes } = await startOnConfiguredComposer();
  await vi.advanceTimersByTimeAsync(5_000);
  // Drawn on the top row, away from the composer, without a PTY frame of its own.
  const written = session.terminal.writeOutput("\u001b7\u001b[1;60Hhost note\u001b8");
  await vi.advanceTimersByTimeAsync(0);
  await written;
  expect(session.terminal.snapshot().text).toContain("host note");
  await vi.advanceTimersByTimeAsync(5_500);
  await sent;
  expect(writes).toEqual(queued);
  expect(statuses).toEqual(["ready", "running"]);
});

test("C-API-28 a write before readiness waits for an open synchronized update", async () => {
  const { session, paint, writes } = await startOnConfiguredComposer();
  await paint(beginSync);
  const prompt = session.sendPrompt("first prompt");
  void prompt.catch(() => {});
  await vi.advanceTimersByTimeAsync(1_000);
  expect(writes).toEqual([]);
  // The update ends on a screen no rule recognizes, which is no configured composer.
  await paint(`${unrecognized}${endSync}`);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(writes).toEqual([]);
  await paint(composer);
  await vi.advanceTimersByTimeAsync(500);
  await prompt;
  expect(writes).toEqual(["\u001b[200~first prompt\u001b[201~", "\r"]);
});
