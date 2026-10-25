/**
 * Raw caller input owns the startup prompt on screen: automation writes nothing more to
 * it, so a retry never lands after the caller's keys (C-TRUST-01, C-CODEX-12).
 */
import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { type CodexSessionApi, startCodex } from "../../src/index.ts";
import { codexComposer, codexTty, tty } from "../fixtures/trust-composer.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

const sessions: CodexSessionApi[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(sessions.splice(0).map((session) => session.teardown()));
  resetFakes();
});

const screen = (path: string) =>
  `\u001b[2J\u001b[H${tty(readFileSync(new URL(path, import.meta.url), "utf8").trimEnd())}`;
/** The folder-access gate Codex 0.156.1 introduced and 0.164 still draws. */
const folderAccess = screen("../fixtures/codex-0.156.1/folder-access.txt");
const hooks = screen("../fixtures/codex-0.154.0/hooks.txt");
const update = screen("../fixtures/codex-0.155.1/update-100x30.txt");
const composer = `\u001b[2J\u001b[H${codexTty(codexComposer)}`;

async function start() {
  installFakes({ supportsHookTrustBypass: false });
  const session = await startCodex({ cwd: tempDir(), autotrust: true });
  sessions.push(session);
  vi.useFakeTimers();
  return session;
}

test("C-TRUST-01 caller keys during a trust answer stop its retries and leave the gate to the caller", async () => {
  const session = await start();
  ptys[0]!.emitData(folderAccess);
  await vi.advanceTimersByTimeAsync(20);
  expect(ptys[0]!.writes).toEqual(["1\r"]);
  // Codex may already have taken the answer and drawn its composer while Elwood's frame
  // still shows the gate; a retry typed after these keys would submit them.
  await session.sendKeys("hello");
  await vi.advanceTimersByTimeAsync(1_000);
  expect(ptys[0]!.writes).toEqual(["1\r", "hello"]);
  // A gate the caller owns that stays on screen past its budget is reported as blocked.
  await vi.advanceTimersByTimeAsync(5_000);
  expect(session.status).toBe("blocked");
  // Nor does the gate repainting after it left the frame return it to automation.
  ptys[0]!.emitData("\u001b[2J\u001b[H");
  await vi.advanceTimersByTimeAsync(20);
  ptys[0]!.emitData(folderAccess);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(ptys[0]!.writes).toEqual(["1\r", "hello"]);
});

test("C-TRUST-01 caller keys own only the gate on screen; the next gate is answered", async () => {
  const session = await start();
  await session.sendKeys("x"); // no gate yet: nothing to own
  ptys[0]!.emitData(folderAccess);
  await vi.advanceTimersByTimeAsync(20);
  expect(ptys[0]!.writes).toEqual(["x", "1\r"]);
  await session.sendKeys("1\r"); // the caller answers the gate itself
  ptys[0]!.emitData(composer);
  await vi.advanceTimersByTimeAsync(20);
  ptys[0]!.emitData(hooks);
  await vi.advanceTimersByTimeAsync(20);
  expect(ptys[0]!.writes).toEqual(["x", "1\r", "1\r", "2\r"]);
});

test("C-CODEX-12 caller keys during an update skip stop its retries; the next prompt is answered", async () => {
  const session = await start();
  ptys[0]!.emitData(update);
  await vi.advanceTimersByTimeAsync(20);
  expect(ptys[0]!.writes).toEqual(["2"]);
  // Codex may already have taken the skip and drawn its trust gate, where 2 is Quit,
  // while Elwood's frame still shows the update prompt.
  await session.sendKeys("hello");
  await vi.advanceTimersByTimeAsync(1_000);
  expect(ptys[0]!.writes).toEqual(["2", "hello"]);
  await session.sendKeys("x"); // the cancelled attempt has nothing left to stop
  ptys[0]!.emitData(folderAccess);
  await vi.advanceTimersByTimeAsync(20);
  expect(ptys[0]!.writes).toEqual(["2", "hello", "x", "1\r"]);
});
