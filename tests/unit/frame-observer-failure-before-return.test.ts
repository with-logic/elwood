/**
 * A frame observer failure that happens while a session starts, before the caller has the
 * session, still reaches a `warning` listener the caller attaches once start returns, on
 * both adapters (PRD §5.4, §5.7; C-API-14, C-API-72).
 */
import { afterEach, expect, test, vi } from "vitest";
import { TurnStateWatcher } from "../../src/core/turn-state.ts";
import {
  type ElwoodAgentSession,
  type ElwoodWarningEvent,
  startClaude,
  startCodex,
} from "../../src/index.ts";
import * as claude from "../claude/helpers.ts";
import * as codex from "../codex/helpers.ts";
import { holdStartup } from "../helpers/startup-frame.ts";

const adapters = {
  codex: { fakes: codex, start: startCodex },
  claude: { fakes: claude, start: startClaude },
} as const;

const teardowns: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(teardowns.splice(0).map((teardown) => teardown()));
  vi.restoreAllMocks();
  claude.resetFakes();
  codex.resetFakes();
});

const agents = ["codex", "claude"] as const;

/**
 * Starts a session whose first frame's observation fails, from an internal fault the frame
 * observer contains, and returns it once start returns, with the caller's `warning` listener.
 */
async function startedAfterFailure(agent: (typeof agents)[number]) {
  const { fakes, start } = adapters[agent];
  fakes.installFakes();
  vi.spyOn(TurnStateWatcher.prototype, "observe").mockImplementationOnce(() => {
    throw new Error("frame observation failed");
  });
  const held = await holdStartup<ElwoodAgentSession>(() => start({ cwd: fakes.tempDir() }));
  teardowns.push(async () => {
    await held.settle();
    const session = await held.starting.catch(() => undefined);
    await session?.teardown();
  });
  const pty = fakes.ptys[0];
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
  agents,
)("C-API-14 C-API-72 a frame failure while a %s session starts is delivered after start returns", async (agent) => {
  const { codes, warnings } = await startedAfterFailure(agent);
  await expect.poll(codes).toEqual(["frame_observer_failed"]);
  expect(warnings[0]).toMatchObject({ agent, source: "lifecycle", severity: "warning" });
});

test.each(
  agents,
)("C-API-72 a startup frame failure is not delivered once the %s session starts closing", async (agent) => {
  const { session, codes } = await startedAfterFailure(agent);
  // Closing begins before the startup warnings are delivered, one macrotask after return.
  const stopped = session.stop();
  await stopped;
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(codes()).not.toContain("frame_observer_failed");
});
