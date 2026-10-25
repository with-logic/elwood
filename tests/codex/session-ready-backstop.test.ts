/** Codex readiness the backstop released says so; ordinary readiness does not (C-API-28). */
import { afterEach, expect, test, vi } from "vitest";
import { type CodexSessionApi, type ElwoodWarningEvent, startCodex } from "../../src/index.ts";
import { codexComposer, codexTty } from "../fixtures/trust-composer.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

const sessions: CodexSessionApi[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(sessions.splice(0).map((session) => session.teardown()));
  resetFakes();
});

/** Codex 0.164's boot composer: painted before the session is configured, without the footer. */
const boot = capturedFrame("codex-0.164.0/boot/boot-composer").trimEnd();

async function start() {
  installFakes();
  const session = await startCodex({ cwd: tempDir() });
  sessions.push(session);
  const warnings: ElwoodWarningEvent[] = [];
  const statuses: string[] = [];
  session.on("warning", (warning) => warnings.push(warning));
  session.on("status", ({ status }) => statuses.push(status));
  vi.useFakeTimers();
  return { session, warnings, statuses };
}

test("C-API-28 Codex readiness released by the backstop warns initial_ready_backstop once", async () => {
  const { session, warnings, statuses } = await start();
  ptys[0]!.emitData(codexTty(boot));
  await vi.advanceTimersByTimeAsync(59_900);
  expect(statuses).toEqual([]);
  expect(warnings).toEqual([]);
  await vi.advanceTimersByTimeAsync(200); // the backstop runs from the first rendered frame
  expect(statuses[0]).toBe("ready");
  expect(warnings).toEqual([
    {
      elwoodSessionId: session.elwoodSessionId,
      agent: "codex",
      source: "lifecycle",
      code: "initial_ready_backstop",
      severity: "warning",
      message: expect.stringContaining("No configured Codex composer"),
      raw: "initial_ready_backstop",
    },
  ]);
});

test("C-API-28 Codex readiness on its configured composer does not warn", async () => {
  const { warnings, statuses } = await start();
  ptys[0]!.emitData(codexTty(boot));
  await vi.advanceTimersByTimeAsync(5_000);
  ptys[0]!.emitData(`\u001b[2J\u001b[H${codexTty(codexComposer)}`);
  await vi.advanceTimersByTimeAsync(5_100);
  expect(statuses).toEqual(["ready"]);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(warnings).toEqual([]);
});
