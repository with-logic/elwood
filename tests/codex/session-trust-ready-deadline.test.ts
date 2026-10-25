/** The cold-start readiness deadline never drains input before a slow trust gate (C-API-28). */
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

const fixture = (path: string) =>
  readFileSync(new URL(`../fixtures/${path}`, import.meta.url), "utf8").trimEnd();
/** Codex 0.164's boot composer: painted before the gate, without the model footer. */
const boot = fixture("codex-0.164.0/boot/boot-composer.txt");
const paste = "\u001b[200~hello\u001b[201~";
/** The folder-access gate Codex 0.156.1 introduced and 0.164 still draws. */
const folderAccess = fixture("codex-0.156.1/folder-access.txt");

test("C-API-28 a trust gate painted after the readiness deadline still precedes ready", async () => {
  installFakes();
  const session = await startCodex({ cwd: tempDir(), autotrust: true });
  sessions.push(session);
  const statuses: string[] = [];
  session.on("status", ({ status }) => statuses.push(status));
  const queued = session.sendMessage("hello");
  vi.useFakeTimers();
  ptys[0]!.emitData(codexTty(boot));
  // Under load Codex 0.164 painted its directory-trust gate more than ten seconds
  // after its first frame; the deadline expires on its boot composer.
  await vi.advanceTimersByTimeAsync(10_500);
  expect(statuses).toEqual([]);
  expect(ptys[0]!.writes).toEqual([]);
  ptys[0]!.emitData(`\u001b[2J\u001b[H${tty(folderAccess)}`);
  await vi.advanceTimersByTimeAsync(20);
  expect(ptys[0]!.writes).toEqual(["1\r"]);
  ptys[0]!.emitData(`\u001b[2J\u001b[H${codexTty(codexComposer)}`);
  await vi.advanceTimersByTimeAsync(500);
  await queued;
  expect(statuses[0]).toBe("ready");
  expect(ptys[0]!.writes).toEqual(["1\r", paste, "\r"]);
});
