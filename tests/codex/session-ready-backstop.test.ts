/** Codex backstop warns without releasing input; ordinary readiness does not warn (C-API-28). */
import { afterEach, expect, test, vi } from "vitest";
import {
  type CodexSessionApi,
  type ElwoodSessionStatus,
  type ElwoodWarningEvent,
  startCodex,
} from "../../src/index.ts";
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
/** Screen text the content-free warning must never carry. */
const sentinel = "elwood-backstop-sentinel";

async function start() {
  installFakes();
  const session = await startCodex({ cwd: tempDir() });
  sessions.push(session);
  const warnings: ElwoodWarningEvent[] = [];
  const statuses: ElwoodSessionStatus[] = [];
  session.on("warning", (warning) => warnings.push(warning));
  session.on("status", ({ status }) => statuses.push(status));
  vi.useFakeTimers();
  return { session, warnings, statuses };
}

test.each([
  "sendMessage",
  "sendPrompt",
] as const)("C-API-28 Codex backstop warns once while %s remains held", async (method) => {
  const { session, warnings, statuses } = await start();
  ptys[0]!.emitData(codexTty(boot.replace("loading", `loading ${sentinel}`)));
  await vi.advanceTimersByTimeAsync(59_900);
  expect(statuses).toEqual([]);
  expect(warnings).toEqual([]);
  await vi.advanceTimersByTimeAsync(200); // the backstop runs from the first rendered frame
  expect(statuses).toEqual([]);
  expect(ptys[0]!.writes).toEqual([]);
  expect(warnings).toEqual([
    {
      elwoodSessionId: session.elwoodSessionId,
      agent: "codex",
      source: "lifecycle",
      code: "initial_ready_backstop",
      severity: "warning",
      message:
        "No configured Codex composer was recognized within 60 seconds of the first frame; readiness and queued input remain held.",
      raw: "initial_ready_backstop",
    },
  ]);
  const sent = session[method]("message behind unknown startup");
  void sent.catch(() => {});
  expect(session.terminal.snapshot().text).toContain(sentinel);
  expect(JSON.stringify(warnings)).not.toContain(sentinel);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(warnings).toHaveLength(1);
  expect(ptys[0]!.writes).toEqual([]);
  ptys[0]!.emitData(`\u001b[2J\u001b[H${codexTty(codexComposer)}`);
  await vi.advanceTimersByTimeAsync(500);
  await sent;
  expect(statuses[0]).toBe("ready");
  expect(ptys[0]!.writes.join("")).toContain("message behind unknown startup");
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

test.each([
  "sendMessage",
  "sendPrompt",
] as const)("C-API-28 %s remains held after the backstop until the update dialog clears", async (method) => {
  const { session, warnings, statuses } = await start();
  ptys[0]!.emitData("\u001b[2J\u001b[HUpdate available! 0.167.2 -> 0.169.0\r\n1. Update now");
  await vi.advanceTimersByTimeAsync(60_100);
  expect(session.status).toBe("blocked");
  expect(warnings.map((event) => event.code)).toContain("initial_ready_backstop");
  const sent = session[method]("queued after the update offer");
  void sent.catch(() => {});
  ptys[0]!.emitData(`\u001b[2J\u001b[H${codexTty(codexComposer)}`);
  await vi.advanceTimersByTimeAsync(500);
  expect(session.status).not.toBe("blocked");
  await sent;
  expect(statuses).toContain("ready");
  expect(ptys[0]!.writes.join("")).toContain("queued after the update offer");
});
