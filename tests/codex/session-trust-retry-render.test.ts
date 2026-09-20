/** Trust retry never authorizes bytes from a stale render (C-TRUST-01). */
import { afterEach, expect, test, vi } from "vitest";
import { type CodexSessionApi, startCodex } from "../../src/index.ts";
import { codexTrust, tty } from "../fixtures/trust-composer.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

const sessions: CodexSessionApi[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(sessions.splice(0).map((session) => session.teardown()));
  vi.restoreAllMocks();
  resetFakes();
});
test.each([
  "staged",
  "failed",
])("C-TRUST-01 trust retries refuse %s replacement output", async (mode) => {
  installFakes();
  const session = await startCodex({ cwd: tempDir(), autotrust: true });
  sessions.push(session);
  vi.useFakeTimers();
  let renderedAt = 0;
  session.on("terminal:data", () => {
    renderedAt = Date.now();
  });
  ptys[0]!.emitData(`${tty(codexTrust)}\r\n› 1. Yes, continue`);
  await vi.advanceTimersByTimeAsync(10);
  expect(ptys[0]!.writes).toEqual(["1\r"]);
  if (mode === "failed") {
    vi.spyOn(session.terminal.xterm, "write").mockImplementationOnce(() => {
      throw new Error("render failed");
    });
    ptys[0]!.emitData("\u001b[2J\u001b[HEnable elevated access?\r\n1. Yes\r\n2. No");
    await vi.advanceTimersByTimeAsync(500);
    expect(session.terminal.renderFailed).toBe(true);
  } else {
    await vi.advanceTimersByTimeAsync(renderedAt + 249 - Date.now());
    ptys[0]!.emitData("\u001b[2J\u001b[HEnable elevated access?\r\n1. Yes\r\n2. No");
    await vi.advanceTimersByTimeAsync(1);
  }
  expect(ptys[0]!.writes).toEqual(["1\r"]);
});
