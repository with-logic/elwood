/**
 * Conformance for Claude bounded initial-readiness (PRD §5.3, C-API-19, C-API-28):
 * readiness is hook-backed. The fallback deadline requires the verified composer,
 * and the backstop diagnoses an unfamiliar screen while holding queued input.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import type { ClaudeSessionApi, ElwoodActivityEvent, ElwoodWarningEvent } from "../../src/index.ts";
import { startClaude } from "../../src/index.ts";
import { claudeComposer, claudeTty, tty } from "../fixtures/trust-composer.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

const PASTE = "[200~hello[201~";

const sessions: ClaudeSessionApi[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(sessions.splice(0).map((session) => session.teardown()));
  resetFakes();
});

describe("ClaudeSessionApi bounded initial readiness", () => {
  test("C-API-28 the deadline releases the queued message once when InstructionsLoaded never arrives", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    sessions.push(session);
    // A message queued before readiness stays unwritten while no readiness fires.
    const queued = session.sendMessage("hello");
    expect(ptys[0]!.writes).toEqual([]);

    // Render a first frame — this arms the starvation deadline. WITHHOLD the
    // `InstructionsLoaded` hook entirely: the hook bridge is treated as never
    // firing, so only the deadline can release the queue.
    vi.useFakeTimers();
    ptys[0]!.emitData(claudeTty(claudeComposer));
    expect(ptys[0]!.writes).toEqual([]); // nothing before the deadline elapses

    // Advance past the 10s bounded deadline (readiness fires) and flush the
    // paste's settle-delayed Enter, then let `queued` settle.
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(500);
    vi.useRealTimers();
    await queued;

    // The queued message released EXACTLY once: one bracketed paste + its Enter.
    expect(ptys[0]!.writes[0]).toBe(PASTE);
    expect(ptys[0]!.writes.filter((w) => w === PASTE)).toHaveLength(1);
    expect(ptys[0]!.writes).toContain("\r");
  });

  test("C-API-28 a later InstructionsLoaded after the deadline does not re-release the message", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    sessions.push(session);
    const queued = session.sendMessage("hello");

    vi.useFakeTimers();
    ptys[0]!.emitData(claudeTty(claudeComposer));
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(500);
    vi.useRealTimers();
    await queued;
    expect(ptys[0]!.writes.filter((w) => w === PASTE)).toHaveLength(1);

    // The InstructionsLoaded hook arriving late is idempotent: readiness already
    // latched via the deadline, so it must not release the message a second time.
    await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "InstructionsLoaded",
      session_id: "claude-1",
      cwd,
      file_path: "/tmp/CLAUDE.md",
      memory_type: "Project",
      load_reason: "session_start",
    });
    expect(ptys[0]!.writes.filter((w) => w === PASTE)).toHaveLength(1);
  });
});

const themePicker = [
  "Choose the text style that looks best with your terminal",
  "To change this later, run /theme",
  "",
  "❯ ✔ Auto (match terminal)",
  "    Light mode",
  "    Dark mode",
].join("\n");

async function startObservedSession() {
  installFakes();
  const session = await startClaude({ cwd: tempDir() });
  sessions.push(session);
  const warnings: ElwoodWarningEvent[] = [];
  const activities: ElwoodActivityEvent[] = [];
  session.on("warning", (event) => warnings.push(event));
  session.on("activity", (event) => activities.push(event));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  vi.useFakeTimers();
  return { session, warnings, activities };
}

async function paint(session: ClaudeSessionApi, bytes: string): Promise<void> {
  ptys[0]!.emitData(`\u001b[2J\u001b[H${bytes}`);
  const settled = session.terminal.settled();
  await vi.advanceTimersByTimeAsync(0);
  await settled;
}

test.each([
  "sendMessage",
  "sendPrompt",
] as const)("C-API-28 C-ATTN-06 a Claude onboarding screen holds %s until the verified composer", async (method) => {
  const { session, warnings, activities } = await startObservedSession();
  await paint(session, tty(themePicker));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(session.status).toBe("running");
  expect(warnings).toEqual([]);
  await vi.advanceTimersByTimeAsync(50_000);
  expect(session.status).toBe("running");
  expect(warnings).toEqual([
    expect.objectContaining({
      agent: "claude",
      source: "lifecycle",
      code: "initial_ready_backstop",
      raw: "initial_ready_backstop",
    }),
  ]);
  expect(JSON.stringify(warnings)).not.toContain(themePicker.split("\n")[0]);
  expect(activities.filter(({ kind }) => kind === "unrecognized_startup")).toEqual([
    {
      elwoodSessionId: session.elwoodSessionId,
      agent: "claude",
      source: "terminal",
      kind: "unrecognized_startup",
      label: "initial_ready_backstop",
      text: themePicker,
    },
  ]);
  const sent = session[method]("hello");
  void sent.catch(() => undefined);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(ptys[0]!.writes).toEqual([]);

  await paint(session, claudeTty(claudeComposer, false));
  await vi.advanceTimersByTimeAsync(500);
  expect(session.status).toBe("running");
  expect(ptys[0]!.writes).toEqual([]);

  await paint(session, claudeTty(claudeComposer));
  await vi.advanceTimersByTimeAsync(500);
  await sent;
  expect(activities).toContainEqual(expect.objectContaining({ kind: "status", status: "ready" }));
  expect(ptys[0]!.writes).toEqual([PASTE, "\r"]);
});

test("C-ATTN-06 the Claude backstop keeps recognized workspace trust on its attention surface", async () => {
  const { session, warnings, activities } = await startObservedSession();
  await paint(session, tty(capturedFrame("claude-2.1.310/folder-trust-no").trimEnd()));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(session.status).toBe("blocked");
  expect(warnings).toEqual([expect.objectContaining({ code: "initial_ready_backstop" })]);
  expect(activities.some(({ kind }) => kind === "unrecognized_startup")).toBe(false);
  expect(ptys[0]!.writes).toEqual([]);
});

test("C-ATTN-06 Claude delivers startup diagnostics before listener-initiated exit", async () => {
  const { session } = await startObservedSession();
  const order: string[] = [];
  let stopped: Promise<void> | undefined;
  session.on("activity", (event) => {
    if (event.kind === "unrecognized_startup") {
      order.push("first screen listener");
      stopped = session.stop();
    }
  });
  session.on("activity", (event) => {
    if (event.kind === "unrecognized_startup") order.push("second screen listener");
  });
  session.on("warning", (event) => {
    if (event.code === "initial_ready_backstop") order.push("warning");
  });
  session.on("terminal:exit", () => order.push("exit"));
  await paint(session, tty(themePicker));
  await vi.advanceTimersByTimeAsync(60_000);
  await stopped;
  expect(order).toEqual(["first screen listener", "second screen listener", "warning", "exit"]);
});
