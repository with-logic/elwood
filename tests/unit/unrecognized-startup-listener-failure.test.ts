/**
 * A throwing status listener cannot drop a startup frame: a screen that blocks the session
 * after the readiness deadline, recognized or not, still reaches `terminal:data`, on both
 * adapters. A listener that throws on the unrecognized screen's report is reported as a
 * frame observer failure (PRD §5.4, C-ATTN-11, C-API-72).
 */
import { afterEach, expect, test, vi } from "vitest";
import {
  type ElwoodActivityEvent,
  type ElwoodAgentSession,
  type ElwoodSessionStatus,
  startClaude,
  startCodex,
} from "../../src/index.ts";
import * as claude from "../claude/helpers.ts";
import * as codex from "../codex/helpers.ts";
import { tty } from "../fixtures/trust-composer.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(stops.splice(0).map((stop) => stop()));
  claude.resetFakes();
  codex.resetFakes();
});

const approval =
  "Would you like to run the following command?\r\n› 1. Yes\r\n  2. No\r\nPress enter to confirm or esc to cancel";
// Each adapter's header drawn alone is a native boot frame, so nothing blocks at the deadline.
const screens = {
  codex: {
    bootHeaderFrame: "  >_ OpenAI Codex (v0.172.0)",
    recognized: approval,
    unrecognized: capturedFrame("codex-0.171.0/startup/sign-in").trimEnd(),
  },
  claude: {
    bootHeaderFrame: " ▐▛███▜▌   Claude Code v2.1.332",
    recognized: "Do you want to proceed?\r\n❯ 1. Yes\r\n  2. No\r\n\r\nEsc to cancel",
    unrecognized: capturedFrame("claude-2.1.332/startup/theme-picker").trimEnd(),
  },
};

async function open(agent: "claude" | "codex", throwOn: "status" | "report" = "status") {
  const fakes = agent === "claude" ? claude : codex;
  fakes.installFakes();
  const options = { cwd: fakes.tempDir() };
  const session: ElwoodAgentSession = await (agent === "claude"
    ? startClaude(options)
    : startCodex(options));
  stops.push(() => session.teardown());
  if (throwOn === "status")
    session.on("status", () => {
      throw new Error("listener failure");
    });
  else
    session.on("activity", ({ kind }) => {
      if (kind === "unrecognized_startup") throw new Error("listener failure");
    });
  const statuses: ElwoodSessionStatus[] = [];
  session.on("status", ({ status }) => statuses.push(status));
  const activities: ElwoodActivityEvent[] = [];
  session.on("activity", (event) => activities.push(event));
  const warnings: string[] = [];
  session.on("warning", ({ code }) => warnings.push(code));
  const data: string[] = [];
  session.on("terminal:data", ({ data: chunk }) => data.push(chunk));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  vi.useFakeTimers();
  const paint = async (frame: string) => {
    fakes.ptys[0]!.emitData(`\u001b[2J\u001b[H${tty(frame)}`);
    const settled = session.terminal.settled();
    await vi.advanceTimersByTimeAsync(0);
    await settled;
  };
  return { statuses, activities, warnings, data, paint };
}

test.each([
  ["codex", "recognized"],
  ["codex", "unrecognized"],
  ["claude", "recognized"],
  ["claude", "unrecognized"],
] as const)("C-ATTN-11 %s delivers a blocking %s frame after the deadline despite a throwing listener", async (agent, kind) => {
  const { statuses, data, paint } = await open(agent);
  await paint(screens[agent].bootHeaderFrame);
  await vi.advanceTimersByTimeAsync(10_500);
  expect(statuses).toEqual([]);
  const frame = screens[agent][kind];
  await paint(frame);
  expect(statuses).toEqual(["blocked"]);
  expect(data.at(-1)).toContain(tty(frame).slice(0, 20));
});

test.each([
  "codex",
  "claude",
] as const)("C-ATTN-11 C-API-72 %s reports a listener that throws on the unrecognized screen's report", async (agent) => {
  const { statuses, activities, warnings, data, paint } = await open(agent, "report");
  await paint(screens[agent].bootHeaderFrame);
  await vi.advanceTimersByTimeAsync(10_500);
  const frame = screens[agent].unrecognized;
  await paint(frame);
  expect(statuses).toEqual(["blocked"]);
  expect(activities.map(({ kind }) => kind)).toEqual(
    expect.arrayContaining(["attention", "unrecognized_startup"]),
  );
  expect(warnings).toEqual(["frame_observer_failed"]);
  expect(data.at(-1)).toContain(tty(frame).slice(0, 20));
});
