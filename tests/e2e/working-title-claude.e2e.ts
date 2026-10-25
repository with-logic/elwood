/**
 * A real Claude 2.1.310 turn animates its OSC title between `◐` and `◑` and paints no
 * `esc to interrupt`, so every title frame must read as working: a `◑` frame read as idle
 * reported `ready` mid-turn, and `send` settled on its quiet window with an empty reply.
 * Implements PRD §5.3 / §5.8, C-TURN-05 and C-API-48.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeSession } from "../../src/index.ts";
import {
  cleanup,
  e2eTimeoutMs,
  type HookEvent,
  makeProject,
  skipIf,
  skipReason,
  skipTurns,
  waitFor,
} from "./helpers.ts";

// Six seconds of tool time spans several title frames and three quiet windows.
const prompt =
  "Use your Bash tool to run `sleep 6`. When it finishes, reply with exactly ELWOOD_SLEEP_OK and nothing else.";

test("C-TURN-05 a real Claude turn stays running through its tool call and send returns its reply", {
  skip: skipIf(skipReason("claude"), skipTurns),
  timeout: e2eTimeoutMs + 30_000,
}, async () => {
  const project = makeProject("claude");
  const session = new ClaudeSession({
    cwd: project.cwd,
    stateDir: project.stateDir,
    permissionMode: "bypassPermissions",
    autotrust: true,
  });
  const log: string[] = [];
  session.on("status", ({ status }) => log.push(`status:${status}`));
  session.on("hook", (event: HookEvent) => log.push(`hook:${event.hook_event_name}`));
  try {
    const reply = await session.send(prompt);
    await waitFor(() => (log.includes("hook:Stop") ? true : undefined), "the turn's Stop hook");
    const toolStart = log.indexOf("hook:PreToolUse");
    const toolEnd = log.indexOf("hook:PostToolUse");
    assert.ok(toolStart >= 0 && toolEnd > toolStart, `no Bash tool call: ${log.join(",")}`);
    const trace = `reply ${JSON.stringify(reply)}; ${log.join(",")}`;
    // The agent is working for the whole tool call: no rendered frame may report it idle.
    const idleDuringTool = log
      .slice(toolStart, toolEnd)
      .filter((entry) => entry === "status:ready");
    assert.deepEqual(idleDuringTool, [], trace);
    assert.equal(reply.trim(), "ELWOOD_SLEEP_OK", trace);
  } finally {
    await cleanup(session.session);
  }
});
