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
  const log: string[] = [];
  // The `sleep 6` call, correlated by its tool-use id so an unrelated tool cannot stand in.
  let sleepCall: string | undefined;
  const session = new ClaudeSession({
    cwd: project.cwd,
    stateDir: project.stateDir,
    permissionMode: "bypassPermissions",
    autotrust: true,
    hooks: {
      PreToolUse: (event) => {
        if (event.tool_name === "Bash" && event.tool_input.command.includes("sleep 6"))
          sleepCall ??= event.tool_use_id;
        log.push(`pre:${event.tool_use_id}`);
        return undefined;
      },
      PostToolUse: (event) => {
        log.push(`post:${event.tool_use_id}`);
      },
      Stop: () => {
        log.push("stop");
      },
    },
  });
  session.on("status", ({ status }) => log.push(`status:${status}`));
  let title = "";
  const sampler = setInterval(() => {
    const next = session.session?.terminal.title ?? "";
    if (next !== title) log.push(`title:${next.slice(0, 1)}`);
    title = next;
  }, 20);
  try {
    const reply = await session.send(prompt);
    await waitFor(() => (log.includes("stop") ? true : undefined), "the turn's Stop hook");
    const trace = `reply ${JSON.stringify(reply)}; ${log.join(",")}`;
    assert.ok(sleepCall !== undefined, `no Bash sleep 6 call: ${trace}`);
    const during = log.slice(log.indexOf(`pre:${sleepCall}`), log.indexOf(`post:${sleepCall}`));
    assert.ok(during.length > 0 && log.includes(`post:${sleepCall}`), trace);
    // The call spans the `◑` half of the animation that used to read as idle ...
    assert.ok(during.includes("title:◑"), `no ◑ title during the call: ${trace}`);
    // ... and the agent is working for the whole call: no rendered frame may report it idle.
    assert.deepEqual(
      during.filter((entry) => entry === "status:ready"),
      [],
      trace,
    );
    assert.equal(reply.trim(), "ELWOOD_SLEEP_OK", trace);
  } finally {
    clearInterval(sampler);
    await cleanup(session.session);
  }
});
