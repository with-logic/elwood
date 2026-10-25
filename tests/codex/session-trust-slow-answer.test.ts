/**
 * A trust answer is typed once, so a slow CLI never submits it from its composer: a retry
 * is Enter alone, or waits for output that shows the gate ignored the answer (C-TRUST-01).
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
/** Its caret starts on "Review hooks", not on the affirmative "Trust all and continue". */
const hooks = screen("../fixtures/codex-0.154.0/hooks.txt");
const composer = `\u001b[2J\u001b[H${codexTty(codexComposer)}`;

async function startAt(gate: string) {
  installFakes({ supportsHookTrustBypass: false });
  const session = await startCodex({ cwd: tempDir(), autotrust: true });
  sessions.push(session);
  const reports: string[] = [];
  session.on("activity", (event) => {
    if (event.kind === "startup_prompt" && event.text !== undefined) reports.push(event.text);
  });
  vi.useFakeTimers();
  ptys[0]!.emitData(gate);
  await vi.advanceTimersByTimeAsync(20);
  return reports;
}

test("C-TRUST-01 a numbered answer is retried as Enter alone while the caret is on it", async () => {
  const reports = await startAt(folderAccess);
  expect(ptys[0]!.writes).toEqual(["1\r"]);
  // Under load Codex takes the answer but paints its composer after the retry interval;
  // a retry typed meanwhile reaches that composer, where Enter alone submits nothing.
  await vi.advanceTimersByTimeAsync(1_000);
  const [, ...retries] = ptys[0]!.writes;
  expect(retries.length).toBeGreaterThan(0);
  expect(retries.every((input) => input === "\r")).toBe(true);
  ptys[0]!.emitData(composer);
  await vi.advanceTimersByTimeAsync(500);
  expect(ptys[0]!.writes.slice(1).every((input) => input === "\r")).toBe(true);
  expect(reports).toEqual(["Detected codex workspace_trust prompt; sent 1."]);
});

test("C-TRUST-01 with the caret elsewhere, the answer repeats only once output shows the gate kept", async () => {
  const reports = await startAt(hooks);
  expect(ptys[0]!.writes).toEqual(["2\r"]);
  // No output since the answer: the CLI may still be processing it.
  await vi.advanceTimersByTimeAsync(1_000);
  expect(ptys[0]!.writes).toEqual(["2\r"]);
  // Output received after the answer still shows the gate: the CLI read past it.
  ptys[0]!.emitData(hooks);
  await vi.advanceTimersByTimeAsync(20);
  expect(ptys[0]!.writes).toEqual(["2\r", "2\r"]);
  ptys[0]!.emitData(composer);
  await vi.advanceTimersByTimeAsync(500);
  expect(ptys[0]!.writes).toEqual(["2\r", "2\r"]);
  expect(reports).toEqual(["Detected codex hook_trust prompt; sent 2."]);
});
