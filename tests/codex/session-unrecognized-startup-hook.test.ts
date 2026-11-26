/**
 * A Codex `SessionStart` hook that arrives while a startup screen Elwood does not recognize
 * blocks the session waits for the verified composer, which then releases queued input
 * once (PRD §5.4, C-ATTN-09).
 */
import { afterEach, expect, test, vi } from "vitest";
import { type CodexSessionApi, type ElwoodSessionStatus, startCodex } from "../../src/index.ts";
import { codexComposer, codexTty, tty } from "../fixtures/trust-composer.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

const sessions: CodexSessionApi[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(sessions.splice(0).map((session) => session.teardown()));
  resetFakes();
});

const signIn = capturedFrame("codex-0.171.0/startup/sign-in").trimEnd();

test("C-ATTN-09 a SessionStart hook during the block waits for the verified composer", async () => {
  installFakes();
  const cwd = tempDir();
  const session = await startCodex({ cwd });
  sessions.push(session);
  const statuses: ElwoodSessionStatus[] = [];
  session.on("status", ({ status }) => statuses.push(status));
  // The startup warning gate opens on a real timer before this test takes over the clock.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  vi.useFakeTimers();
  const paint = async (frame: string) => {
    ptys[0]!.emitData(`\u001b[2J\u001b[H${frame}`);
    const settled = session.terminal.settled();
    await vi.advanceTimersByTimeAsync(0);
    await settled;
  };
  const sent = session.sendMessage("held behind the sign-in screen");
  void sent.catch(() => {});
  await paint(tty(signIn));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(statuses).toEqual(["blocked"]);
  await becomeReady(session.elwoodSessionId, cwd);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(statuses).toEqual(["blocked"]);
  expect(ptys[0]!.writes).toEqual([]);
  await paint(codexTty(codexComposer));
  await vi.advanceTimersByTimeAsync(500);
  await sent;
  expect(statuses.slice(0, 2)).toEqual(["blocked", "ready"]);
  expect(ptys[0]!.writes).toEqual(["\u001b[200~held behind the sign-in screen\u001b[201~", "\r"]);
});
