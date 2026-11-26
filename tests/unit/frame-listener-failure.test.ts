/**
 * A listener that throws while Elwood observes a rendered frame cannot drop that frame's
 * other notifications or its `terminal:data`. One content-free `frame_observer_failed`
 * warning reports it, on both adapters (PRD §5.4, C-API-72).
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
import { claudeComposer, claudeTty, codexComposer, codexTty } from "../fixtures/trust-composer.ts";

const teardowns: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(teardowns.splice(0).map((teardown) => teardown()));
  claude.resetFakes();
  codex.resetFakes();
});

const clear = "\u001b[2J\u001b[H";
const adapters = {
  codex: {
    fakes: codex,
    start: startCodex,
    dialog:
      "Would you like to run the following command?\r\n› 1. Yes\r\n  2. No\r\nPress enter to confirm or esc to cancel",
    composer: codexTty(codexComposer),
  },
  claude: {
    fakes: claude,
    start: startClaude,
    dialog: "Do you want to proceed?\r\n❯ 1. Yes\r\n  2. No\r\n\r\nEsc to cancel",
    composer: claudeTty(claudeComposer),
  },
} as const;

async function started(agent: keyof typeof adapters) {
  const { fakes, start } = adapters[agent];
  fakes.installFakes();
  const session: ElwoodAgentSession = await start({ cwd: fakes.tempDir() });
  teardowns.push(() => session.teardown());
  const statuses: ElwoodSessionStatus[] = [];
  const activities: ElwoodActivityEvent[] = [];
  const chunks: string[] = [];
  const warnings: string[] = [];
  session.on("status", ({ status }) => statuses.push(status));
  session.on("activity", (event) => activities.push(event));
  session.on("terminal:data", ({ data }) => chunks.push(data));
  session.on("warning", ({ code }) => warnings.push(code));
  // The startup warning gate opens on a real timer before the test takes over the clock.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  vi.useFakeTimers();
  const paint = async (frame: string) => {
    fakes.ptys[0]!.emitData(`${clear}${frame}`);
    const settled = session.terminal.settled();
    await vi.advanceTimersByTimeAsync(0);
    await settled;
  };
  return { session, statuses, activities, chunks, warnings, paint };
}

test.each([
  "codex",
  "claude",
] as const)("C-API-72 %s delivers a blocking frame's notifications despite a throwing status listener", async (agent) => {
  const { session, statuses, activities, chunks, warnings, paint } = await started(agent);
  session.on("status", () => {
    throw new Error("listener failure");
  });
  const { dialog } = adapters[agent];
  await paint(dialog);
  expect(statuses).toEqual(["blocked"]);
  // The warning is delivered after the frame, as its own activity.
  expect(activities.map(({ kind }) => kind)).toEqual(["status", "attention", "warning"]);
  expect(chunks.at(-1)).toContain(dialog);
  expect(warnings).toEqual(["frame_observer_failed"]);
  // A later failure is not reported again.
  await paint(adapters[agent].composer);
  await paint(dialog);
  expect(warnings).toEqual(["frame_observer_failed"]);
});

test.each([
  "codex",
  "claude",
] as const)("C-API-72 %s delivers a blocking frame despite a throwing attention listener", async (agent) => {
  const { session, statuses, chunks, warnings, paint } = await started(agent);
  session.on("activity", ({ kind }) => {
    if (kind === "attention") throw new Error("listener failure");
  });
  const { dialog } = adapters[agent];
  await paint(dialog);
  expect(statuses).toEqual(["blocked"]);
  expect(chunks.at(-1)).toContain(dialog);
  expect(warnings).toEqual(["frame_observer_failed"]);
});
