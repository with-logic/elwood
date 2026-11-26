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
  type ElwoodWarningEvent,
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
  const warnings: ElwoodWarningEvent[] = [];
  session.on("status", ({ status }) => statuses.push(status));
  session.on("activity", (event) => activities.push(event));
  session.on("terminal:data", ({ data }) => chunks.push(data));
  session.on("warning", (event) => warnings.push(event));
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

const sentinel = "listener failure 7f3c9e";

type Run = Awaited<ReturnType<typeof started>>;

/** The warnings and warning activities delivered, and any error or frame text they carry. */
function delivered({ warnings, activities }: Run, agent: keyof typeof adapters) {
  const activity = activities.filter(({ kind }) => kind === "warning");
  const text = JSON.stringify([warnings, activity]);
  const frameText = adapters[agent].dialog.split("\r\n")[0] ?? "";
  return { warnings, activity, leaked: [sentinel, frameText].filter((t) => text.includes(t)) };
}

/** One content-free `frame_observer_failed` warning and its activity. */
function oneWarning({ session }: Run, agent: keyof typeof adapters) {
  const warning = {
    elwoodSessionId: session.elwoodSessionId,
    agent,
    source: "lifecycle",
    code: "frame_observer_failed",
    severity: "warning",
    message: "A rendered-frame notification failed.",
    raw: "frame_observer_failed",
  };
  const { elwoodSessionId, source } = warning;
  const text = warning.message;
  const activity = { elwoodSessionId, agent, source, kind: "warning", label: warning.code, text };
  return { warnings: [warning], activity: [{ ...activity, raw: warning }], leaked: [] };
}

test.each([
  "codex",
  "claude",
] as const)("C-API-72 %s delivers a blocking frame's notifications despite a throwing status listener", async (agent) => {
  const run = await started(agent);
  const { session, statuses, activities, chunks, paint } = run;
  session.on("status", () => {
    throw new Error(sentinel);
  });
  const { dialog } = adapters[agent];
  await paint(dialog);
  expect(statuses).toEqual(["blocked"]);
  // The warning is delivered after the frame, as its own activity.
  expect(activities.map(({ kind }) => kind)).toEqual(["status", "attention", "warning"]);
  expect(chunks.at(-1)).toContain(dialog);
  expect(delivered(run, agent)).toEqual(oneWarning(run, agent));
  // A later failure is not reported again.
  await paint(adapters[agent].composer);
  await paint(dialog);
  expect(delivered(run, agent)).toEqual(oneWarning(run, agent));
});

test.each([
  "codex",
  "claude",
] as const)("C-API-72 %s delivers a blocking frame despite a throwing attention listener", async (agent) => {
  const run = await started(agent);
  const { session, statuses, chunks, paint } = run;
  session.on("activity", ({ kind }) => {
    if (kind === "attention") throw new Error(sentinel);
  });
  const { dialog } = adapters[agent];
  await paint(dialog);
  expect(statuses).toEqual(["blocked"]);
  expect(chunks.at(-1)).toContain(dialog);
  expect(delivered(run, agent)).toEqual(oneWarning(run, agent));
});
