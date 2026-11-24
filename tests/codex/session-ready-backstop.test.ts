/** Codex backstop warns without releasing input; ordinary readiness does not warn (C-API-28). */
import { afterEach, expect, test, vi } from "vitest";
import {
  type CodexSessionApi,
  type ElwoodActivityEvent,
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
  const activities: ElwoodActivityEvent[] = [];
  session.on("warning", (warning) => warnings.push(warning));
  session.on("status", ({ status }) => statuses.push(status));
  session.on("activity", (event) => activities.push(event));
  // The startup warning gate opens on a real timer before this test takes over the clock.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  vi.useFakeTimers();
  return { session, warnings, statuses, activities };
}

/** Render the frame so its readiness timer is armed before fake time advances. */
async function settleFrame(session: CodexSessionApi): Promise<void> {
  const settled = session.terminal.settled();
  await vi.advanceTimersByTimeAsync(0);
  await settled;
}

test.each([
  "sendMessage",
  "sendPrompt",
] as const)("C-API-28 Codex backstop warns once while %s remains held", async (method) => {
  const { session, warnings, statuses, activities } = await start();
  ptys[0]!.emitData(codexTty(boot.replace("loading", `loading ${sentinel}`)));
  await settleFrame(session);
  await vi.advanceTimersByTimeAsync(59_900);
  expect(statuses).toEqual([]);
  expect(warnings).toEqual([]);
  expect(activities.some((event) => event.kind === "unrecognized_startup")).toBe(false);
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
  const unrecognized = () => activities.filter((event) => event.kind === "unrecognized_startup");
  expect(unrecognized()).toEqual([
    {
      elwoodSessionId: session.elwoodSessionId,
      agent: "codex",
      source: "terminal",
      kind: "unrecognized_startup",
      label: "initial_ready_backstop",
      text: expect.stringContaining(sentinel),
    },
  ]);
  const lateEvents: ElwoodActivityEvent[] = [];
  session.on("activity", (event) => lateEvents.push(event));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(lateEvents.some((event) => event.kind === "unrecognized_startup")).toBe(false);
  expect(warnings).toHaveLength(1);
  expect(unrecognized()).toHaveLength(1);
  expect(ptys[0]!.writes).toEqual([]);
  ptys[0]!.emitData(`\u001b[2J\u001b[H${codexTty(codexComposer)}`);
  await settleFrame(session);
  await vi.advanceTimersByTimeAsync(500);
  await sent;
  expect(statuses[0]).toBe("ready");
  expect(ptys[0]!.writes.join("")).toContain("message behind unknown startup");
});

test.each([
  { label: "legacy", frame: codexComposer },
  { label: "lowercase fast", frame: capturedFrame("codex-0.170.0/xhigh-fast-composer") },
  { label: "effort-only", frame: capturedFrame("codex-0.170.0/effort-only-composer") },
])("C-API-28 Codex $label composer releases startup input without warning", async ({ frame }) => {
  const { session, warnings, statuses, activities } = await start();
  const sent = session.sendMessage("ordinary initial prompt");
  void sent.catch(() => {});
  ptys[0]!.emitData(codexTty(boot));
  await settleFrame(session);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(ptys[0]!.writes.join("")).not.toContain("ordinary initial prompt");
  ptys[0]!.emitData(`\u001b[2J\u001b[H${codexTty(frame)}`);
  await settleFrame(session);
  await vi.advanceTimersByTimeAsync(5_500);
  expect(statuses).toEqual(["ready", "running"]);
  await sent;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(ptys[0]!.writes).toEqual(["\u001b[200~ordinary initial prompt\u001b[201~", "\r"]);
  expect(warnings).toEqual([]);
  expect(activities.some((event) => event.kind === "unrecognized_startup")).toBe(false);
});

test.each([
  "sendMessage",
  "sendPrompt",
] as const)("C-API-28 %s remains held after the backstop until the update dialog clears", async (method) => {
  const { session, warnings, statuses, activities } = await start();
  ptys[0]!.emitData("\u001b[2J\u001b[HUpdate available! 0.167.2 -> 0.169.0\r\n1. Update now");
  await settleFrame(session);
  await vi.advanceTimersByTimeAsync(60_100);
  expect(session.status).toBe("blocked");
  expect(warnings.map((event) => event.code)).toContain("initial_ready_backstop");
  expect(activities.some((event) => event.kind === "unrecognized_startup")).toBe(false);
  const sent = session[method]("queued after the update offer");
  const settled = vi.fn();
  void sent.then(settled, settled);
  await vi.advanceTimersByTimeAsync(0);
  expect(ptys[0]!.writes).toEqual([]);
  expect(settled).not.toHaveBeenCalled();
  ptys[0]!.emitData(`\u001b[2J\u001b[H${codexTty(codexComposer)}`);
  await settleFrame(session);
  await vi.advanceTimersByTimeAsync(500);
  expect(session.status).not.toBe("blocked");
  await sent;
  expect(statuses).toContain("ready");
  expect(ptys[0]!.writes.join("")).toContain("queued after the update offer");
});

test("C-ATTN-06 the startup activity uses live screen text while the host views history", async () => {
  const { session, warnings, activities } = await start();
  const pty = ptys[0]!;
  pty.emitData("Earlier startup output\r\n".repeat(session.terminal.size.rows * 3));
  await settleFrame(session);
  session.terminal.xterm.scrollToTop();
  pty.emitData("\u001b[2J\u001b[HNew native startup screen");
  await settleFrame(session);
  expect(session.terminal.snapshot().text).toContain("Earlier startup output");
  pty.emitData("\u001b[?2026h\u001b[2J\u001b[HIncomplete startup repaint");
  await settleFrame(session);
  session.on("activity", (event) => {
    if (event.kind === "unrecognized_startup") throw new Error("listener failure");
  });
  session.on("activity", (event) =>
    event.kind === "unrecognized_startup"
      ? Promise.reject(new Error("listener rejection"))
      : undefined,
  );
  const finalListener = vi.fn();
  session.on("activity", finalListener);
  await vi.advanceTimersByTimeAsync(60_100);
  expect(finalListener).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "unrecognized_startup", text: "New native startup screen" }),
  );
  expect(activities.filter((event) => event.kind === "unrecognized_startup")).toMatchObject([
    { text: "New native startup screen" },
  ]);
  expect(warnings.map(({ code }) => code)).toEqual(["initial_ready_backstop"]);
  expect(pty.writes).toEqual([]);
});

test("C-ATTN-06 a completed blank startup screen has empty text", async () => {
  const { session, warnings, activities } = await start();
  ptys[0]!.emitData("\u001b[2J\u001b[H");
  await settleFrame(session);
  await vi.advanceTimersByTimeAsync(60_100);
  expect(activities.filter((event) => event.kind === "unrecognized_startup")).toMatchObject([
    { text: "" },
  ]);
  expect(warnings.map(({ code }) => code)).toEqual(["initial_ready_backstop"]);
});
