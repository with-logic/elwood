/** Raw caller input owns Claude's trust gate on screen: automation stops (C-TRUST-01). */
import { afterEach, expect, test, vi } from "vitest";
import { type ClaudeSessionApi, startClaude } from "../../src/index.ts";
import { claudeTrust, tty } from "../fixtures/trust-composer.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

const sessions: ClaudeSessionApi[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(sessions.splice(0).map((session) => session.teardown()));
  resetFakes();
});

test("C-TRUST-01 caller keys on Claude's cursor gate stop its selection writes", async () => {
  installFakes();
  const session = await startClaude({ cwd: tempDir(), autotrust: true });
  sessions.push(session);
  vi.useFakeTimers();
  // Claude 2.1.310 remounts its dialog with the cursor on the decline.
  ptys[0]!.emitData(`${tty(claudeTrust)}\r\n❯ No, exit\r\n  Yes, I trust this folder`);
  await vi.advanceTimersByTimeAsync(20);
  expect(ptys[0]!.writes).toEqual(["\u001b[H\u001b[B"]);
  await session.sendKeys("\u001b[A"); // the caller moves the cursor itself
  await vi.advanceTimersByTimeAsync(1_000);
  ptys[0]!.emitData(
    `\u001b[2J\u001b[H${tty(claudeTrust)}\r\n  No, exit\r\n❯ Yes, I trust this folder`,
  );
  await vi.advanceTimersByTimeAsync(1_000);
  expect(ptys[0]!.writes).toEqual(["\u001b[H\u001b[B", "\u001b[A"]);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(session.status).toBe("blocked");
  expect(ptys[0]!.writes).toEqual(["\u001b[H\u001b[B", "\u001b[A"]);
});
