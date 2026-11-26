/**
 * Conformance for Claude bounded initial-readiness (PRD §5.3, C-API-19, C-API-28):
 * readiness is hook-backed. The fallback deadline requires the verified composer. From
 * the deadline an unfamiliar screen blocks the session (C-ATTN-11), and the backstop
 * diagnoses it, while queued input is held.
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

function instructionsLoaded(session: ClaudeSessionApi) {
  return ptys[0]!.dispatchHook(session.elwoodSessionId, {
    hook_event_name: "InstructionsLoaded",
    session_id: "claude-1",
    cwd: session.cwd,
    file_path: "/tmp/CLAUDE.md",
    memory_type: "Project",
    load_reason: "session_start",
  });
}

describe("ClaudeSessionApi bounded initial readiness", () => {
  test("C-API-28 the deadline releases the queued message once when InstructionsLoaded never arrives", async () => {
    const { session } = await startObservedSession();
    const queued = session.sendMessage("hello");
    await paint(session, claudeTty(claudeComposer));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(ptys[0]!.writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(501);
    expect(ptys[0]!.writes).toEqual([PASTE, "\r"]);
    await queued;
  });

  test("C-API-28 a later InstructionsLoaded after the deadline does not re-release the message", async () => {
    const { session } = await startObservedSession();
    const queued = session.sendMessage("hello");
    await paint(session, claudeTty(claudeComposer));
    await vi.advanceTimersByTimeAsync(10_500);
    expect(ptys[0]!.writes).toEqual([PASTE, "\r"]);
    await queued;
    await instructionsLoaded(session);
    await vi.advanceTimersByTimeAsync(500);
    expect(ptys[0]!.writes).toEqual([PASTE, "\r"]);
  });
});

/** Claude 2.1.332's text-style picker on a first launch. */
const themePicker = capturedFrame("claude-2.1.332/startup/theme-picker").trimEnd();

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

/** No readiness hook arrives before the verified composer. */
const noHook = async (_session: ClaudeSessionApi) => undefined;

test.each([
  ["sendMessage", "verified composer", noHook],
  ["sendPrompt", "verified composer", noHook],
  ["sendMessage", "InstructionsLoaded", instructionsLoaded],
  ["sendPrompt", "InstructionsLoaded", instructionsLoaded],
] as const)("C-API-28 C-ATTN-06 C-ATTN-11 Claude holds %s on an unrecognized screen until %s", async (method, _, hook) => {
  const { session, warnings, activities } = await startObservedSession();
  await paint(session, tty(themePicker));
  await vi.advanceTimersByTimeAsync(9_999);
  expect(session.status).toBe("running");
  expect(activities.filter(({ kind }) => kind === "attention")).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(session.status).toBe("blocked");
  expect(warnings).toEqual([]);
  const report = {
    elwoodSessionId: session.elwoodSessionId,
    agent: "claude",
    source: "terminal",
    kind: "unrecognized_startup",
    label: "initial_ready_deadline",
    text: themePicker,
  };
  expect(
    activities.filter(({ kind }) => kind === "attention" || kind === "unrecognized_startup"),
  ).toEqual([
    expect.objectContaining({ kind: "attention", label: "claude-unrecognized-startup" }),
    report,
  ]);
  await vi.advanceTimersByTimeAsync(50_000);
  expect(session.status).toBe("blocked");
  const warning = {
    elwoodSessionId: session.elwoodSessionId,
    agent: "claude",
    source: "lifecycle",
    code: "initial_ready_backstop",
    severity: "warning",
    message:
      "No configured Claude composer was recognized within 60 seconds of the first frame; readiness and queued input remain held.",
    raw: "initial_ready_backstop",
  };
  expect(warnings).toEqual([warning]);
  expect(activities.filter(({ kind }) => kind === "warning")).toEqual([
    {
      elwoodSessionId: session.elwoodSessionId,
      agent: "claude",
      source: "lifecycle",
      kind: "warning",
      label: "initial_ready_backstop",
      text: warning.message,
      raw: warning,
    },
  ]);
  expect(activities.filter(({ kind }) => kind === "unrecognized_startup")).toEqual([
    report,
    { ...report, label: "initial_ready_backstop" },
  ]);
  const sent = session[method]("hello");
  void sent.catch(() => undefined);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(ptys[0]!.writes).toEqual([]);

  // A readiness hook waits for the verified composer, as during a recognized dialog.
  await hook(session);
  await vi.advanceTimersByTimeAsync(500);
  expect(session.status).toBe("blocked");
  expect(ptys[0]!.writes).toEqual([]);
  await paint(session, claudeTty(claudeComposer, false));
  await vi.advanceTimersByTimeAsync(500);
  expect(session.status).toBe("blocked");
  expect(ptys[0]!.writes).toEqual([]);
  await paint(session, claudeTty(claudeComposer));
  await vi.advanceTimersByTimeAsync(500);
  expect(activities).toContainEqual(expect.objectContaining({ kind: "status", status: "ready" }));
  expect(ptys[0]!.writes).toEqual([PASTE, "\r"]);
  await sent;
});

test("C-ATTN-06 the Claude backstop keeps recognized workspace trust on its attention surface", async () => {
  const { session, warnings, activities } = await startObservedSession();
  await paint(session, tty(capturedFrame("claude-2.1.310/folder-trust-no").trimEnd()));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(session.status).toBe("blocked");
  expect(activities).toContainEqual(
    expect.objectContaining({ kind: "attention", label: "claude-workspace_trust-prompt" }),
  );
  expect(warnings).toEqual([expect.objectContaining({ code: "initial_ready_backstop" })]);
  expect(activities.some(({ kind }) => kind === "unrecognized_startup")).toBe(false);
  expect(ptys[0]!.writes).toEqual([]);
});

test("C-ATTN-06 Claude delivers startup diagnostics before listener-initiated exit", async () => {
  const { session } = await startObservedSession();
  const order: string[] = [];
  let stopped: Promise<void> | undefined;
  const backstop = (event: ElwoodActivityEvent) =>
    event.kind === "unrecognized_startup" && event.label === "initial_ready_backstop";
  session.on("activity", (event) => {
    if (backstop(event)) {
      order.push("first screen listener");
      stopped = session.stop();
    }
  });
  session.on("activity", (event) => {
    if (backstop(event)) order.push("second screen listener");
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
