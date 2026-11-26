/**
 * A frame observer failure that happens while a session starts or resumes, before the
 * caller has the session, still reaches a `warning` listener the caller attaches once start
 * or resume returns, on both adapters (PRD §5.4, §5.7; C-API-14, C-API-72).
 */
import { afterEach, expect, test, vi } from "vitest";
import { TurnStateWatcher } from "../../src/core/turn-state.ts";
import {
  type ElwoodAgentSession,
  type ElwoodWarningEvent,
  resumeClaude,
  resumeCodex,
  startClaude,
  startCodex,
} from "../../src/index.ts";
import * as claude from "../claude/helpers.ts";
import * as codex from "../codex/helpers.ts";
import { holdStartup } from "../helpers/startup-frame.ts";

// Each adapter's hook that records the native conversation a resume continues.
const adapters = {
  codex: {
    fakes: codex,
    start: startCodex,
    resume: resumeCodex,
    conversation: { hook_event_name: "SessionStart", source: "startup", model: "fixture" },
  },
  claude: {
    fakes: claude,
    start: startClaude,
    resume: resumeClaude,
    conversation: { hook_event_name: "UserPromptSubmit", prompt: "existing conversation" },
  },
} as const;

const teardowns: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(teardowns.splice(0).map((teardown) => teardown()));
  vi.restoreAllMocks();
  claude.resetFakes();
  codex.resetFakes();
});

const agents = ["codex", "claude"] as const;
type Agent = (typeof agents)[number];
type Launch = "start" | "resume";
const launches = agents.flatMap((agent) => [[agent, "start"] as const, [agent, "resume"] as const]);

/** The options that start a session, or resume one that has a native conversation. */
async function launchOptions(agent: Agent, launch: Launch) {
  const { fakes, start, conversation } = adapters[agent];
  const options = { cwd: fakes.tempDir(), stateDir: fakes.tempDir() };
  if (launch === "start") return options;
  const original = await start(options);
  const hook = { ...conversation, session_id: `${agent}-resume`, cwd: options.cwd };
  await fakes.ptys[0]?.dispatchHook(original.elwoodSessionId, hook, options.stateDir);
  await original.stop();
  return { ...options, elwoodSessionId: original.elwoodSessionId };
}

/**
 * Starts or resumes a session whose first frame's observation fails, from an internal fault
 * the frame observer contains, and returns it once start or resume returns, with the
 * caller's `warning` listener.
 */
async function launchedAfterFailure(agent: Agent, launch: Launch) {
  const { fakes, start, resume } = adapters[agent];
  fakes.installFakes();
  const options = await launchOptions(agent, launch);
  vi.spyOn(TurnStateWatcher.prototype, "observe").mockImplementationOnce(() => {
    throw new Error("frame observation failed");
  });
  const held = await holdStartup<ElwoodAgentSession>(() =>
    "elwoodSessionId" in options ? resume(options) : start(options),
  );
  teardowns.push(async () => {
    await held.settle();
    const session = await held.starting.catch(() => undefined);
    await session?.teardown();
  });
  const pty = fakes.ptys.at(-1);
  if (!pty) throw new Error("the session spawned no PTY");
  pty.emitData("\u001b[2J\u001b[HStarting");
  await vi.waitFor(() => {
    if (held.renders() !== 1) throw new Error("the first frame has not rendered");
  });
  // One macrotask: the failure's report has run while start has not returned yet.
  await new Promise((resolve) => setImmediate(resolve));
  held.release();
  const session = await held.starting;
  const warnings: ElwoodWarningEvent[] = [];
  session.on("warning", (warning) => {
    warnings.push(warning);
  });
  return { session, codes: () => warnings.map((warning) => warning.code), warnings };
}

test.each(
  launches,
)("C-API-14 C-API-72 a frame failure while a %s session's %s runs is delivered after it returns", async (agent, launch) => {
  const { codes, warnings } = await launchedAfterFailure(agent, launch);
  await expect.poll(codes).toEqual(["frame_observer_failed"]);
  expect(warnings[0]).toMatchObject({ agent, source: "lifecycle", severity: "warning" });
});

test.each(
  agents,
)("C-API-72 a startup frame failure is not delivered once the %s session starts closing", async (agent) => {
  const { session, codes } = await launchedAfterFailure(agent, "start");
  // Closing begins before the startup warnings are delivered, one macrotask after return,
  // and stopping waits for that delivery.
  await session.stop();
  expect(codes()).not.toContain("frame_observer_failed");
});
