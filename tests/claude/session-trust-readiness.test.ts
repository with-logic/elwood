/** Automation-owned trust holds readiness and input without human attention (C-API-28). */
import { afterEach, expect, test, vi } from "vitest";
import { startClaude } from "../../src/index.ts";
import { claudeComposer, claudeTrust, claudeTty, tty } from "../fixtures/trust-composer.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  resetFakes();
});

test("C-TRUST-01 expired cursor navigation holds the readiness deadline until the gate clears", async () => {
  installFakes();
  const session = await startClaude({ cwd: tempDir(), autotrust: true });
  const warnings: string[] = [];
  const activity: string[] = [];
  session.on("warning", (event) => warnings.push(event.code));
  session.on("activity", (event) => activity.push(`${event.kind}:${event.label}`));
  const queued = session.sendMessage("hello");
  vi.useFakeTimers();
  ptys[0]!.emitData(`${tty(claudeTrust)}\r\n❯ No, exit\r\n  Yes, I trust this folder`);
  await vi.advanceTimersByTimeAsync(11_000);
  expect(ptys[0]!.writes.length).toBeGreaterThan(0);
  expect(ptys[0]!.writes.every((input) => input === "\u001b[B")).toBe(true);
  expect(session.status).not.toBe("ready");
  expect(session.status).toBe("blocked");
  expect(warnings).toEqual([]);
  expect(activity).not.toContain("startup_prompt:workspace_trust");
  expect(activity).toContain("attention:claude-workspace_trust-prompt");
  ptys[0]!.emitData(`\u001b[2J\u001b[H${claudeTty(claudeComposer)}`);
  await vi.advanceTimersByTimeAsync(500);
  await queued;
  expect(ptys[0]!.writes).toContain("\u001b[200~hello\u001b[201~");
  vi.useRealTimers();
  await session.teardown();
});

test("C-TRUST-01 a trust gate appearing after readiness holds the entire queued paste", async () => {
  installFakes();
  const session = await startClaude({ cwd: tempDir(), autotrust: true });
  vi.useFakeTimers();
  ptys[0]!.emitData("Claude ready\r\n❯ ");
  await vi.advanceTimersByTimeAsync(10_010);
  expect(session.status).toBe("ready");
  const activity: string[] = [];
  const warnings: string[] = [];
  session.on("activity", (event) => activity.push(`${event.kind}:${event.label}`));
  session.on("warning", (event) => warnings.push(event.code));
  ptys[0]!.emitData(`\u001b[2J\u001b[H${tty(claudeTrust)}\r\n1. Yes\r\n2. No`);
  await vi.advanceTimersByTimeAsync(10);
  const queued = session.sendMessage("held");
  await vi.advanceTimersByTimeAsync(5_500);
  expect(ptys[0]!.writes.length).toBeGreaterThan(1);
  expect(ptys[0]!.writes.every((input) => input === "1\r")).toBe(true);
  expect(warnings).toEqual([]);
  expect(activity).not.toContain("startup_prompt:workspace_trust");
  expect(activity).toContain("attention:claude-workspace_trust-prompt");
  ptys[0]!.emitData(`\u001b[2J\u001b[H${claudeTty(claudeComposer)}`);
  await vi.advanceTimersByTimeAsync(500);
  await queued;
  expect(ptys[0]!.writes).toContain("\u001b[200~held\u001b[201~");
  vi.useRealTimers();
  await session.teardown();
});
