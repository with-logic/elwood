/**
 * Regression coverage for review feedback fixes.
 * Covers PRD §5, §6, §8, §9, §10, and §11.
 */

import { createServer } from "node:http";
import { describe, expect, test } from "vitest";
import {
  createBrowserToken,
  createGuardedWebSocketServer,
  guardUpgrade,
  isAllowedUpgrade,
} from "../../src/app/web-security.ts";
import { normalizeClaudeHookEvent } from "../../src/claude/normalize.ts";
import { isClaudeToolInputUpdate } from "../../src/claude/validate-tool-update.ts";
import { TerminalReplayBuffer } from "../../src/core/terminal-replay.ts";
import { canTransition } from "../../src/runtime/session-status.ts";
import { cleanupStartupResources } from "../../src/runtime/startup-cleanup.ts";
import { runTeardownSteps } from "../../src/runtime/teardown.ts";

describe("review feedback regressions", () => {
  test("C-PTY-03 terminal replay bounds a single oversized chunk", () => {
    const buffer = new TerminalReplayBuffer("e1", 4);
    const replayed: string[] = [];
    buffer.push("abcdef");
    buffer.replay((event) => replayed.push(event.data));
    expect(replayed).toEqual(["cdef"]);
  });

  test("C-HOOK-08 normalizes future Claude tool names", () => {
    const normalized = normalizeClaudeHookEvent({
      hook_event_name: "PreToolUse",
      session_id: "s1",
      cwd: "/tmp",
      tool_name: "FutureTool",
      tool_input: { raw: true },
    });
    expect("tool_name" in normalized && normalized.tool_name).toBe("unknown:FutureTool");
  });

  test("C-HRESP-01 validates Claude tool-specific input rewrites", () => {
    expect(isClaudeToolInputUpdate("Bash", { command: "echo ok" })).toBe(true);
    expect(isClaudeToolInputUpdate("Edit", { old_string: "a" })).toBe(true);
    expect(isClaudeToolInputUpdate("Grep", { pattern: "x" })).toBe(true);
    expect(isClaudeToolInputUpdate("Bash", { questions: [] })).toBe(false);
    expect(isClaudeToolInputUpdate("mcp__server__tool", { questions: [] })).toBe(true);
  });

  test("C-LIFE-04 lifecycle statuses are monotonic after terminal states", () => {
    expect(canTransition("killed", "stopped")).toBe(false);
    expect(canTransition("torn_down", "running")).toBe(false);
    expect(canTransition("exited", "ready")).toBe(false);
    expect(canTransition("running", "ready")).toBe(true);
  });

  test("C-ERR-07 startup cleanup preserves original errors", async () => {
    const calls: string[] = [];
    await cleanupStartupResources({
      before: () => calls.push("before"),
      pty: {
        pid: 1,
        onData: () => () => {},
        onExit: () => () => {},
        write: () => {},
        resize: () => "resized",
        kill: () => calls.push("kill"),
      },
      bridge: {
        stop: () => Promise.reject(new Error("bridge")),
      },
      terminal: { dispose: () => calls.push("dispose") },
      after: () => calls.push("after"),
    });
    expect(calls).toEqual(["before", "kill", "after", "dispose"]);
  });

  test("C-STATE-09 teardown attempts all cleanup steps before throwing", async () => {
    const calls: string[] = [];
    await expect(
      runTeardownSteps([
        () => {
          calls.push("first");
          throw new Error("first failed");
        },
        () => {
          calls.push("second");
        },
      ]),
    ).rejects.toMatchObject({ code: "teardown_failed" });
    expect(calls).toEqual(["first", "second"]);
  });

  test("C-APP-08 web dev sockets require loopback origin and token", () => {
    const request = (url: string, host = "localhost:4317", origin = "http://localhost:4317") =>
      ({ url, headers: { host, origin } }) as never;
    const token = createBrowserToken();
    expect(token.length).toBeGreaterThan(0);
    expect(isAllowedUpgrade(request("/?token=secret"), "secret", 4317)).toBe(true);
    expect(isAllowedUpgrade(request("/?token=bad"), "secret", 4317)).toBe(false);
    expect(isAllowedUpgrade(request("/?token=secret", "0.0.0.0:4317"), "secret", 4317)).toBe(false);
    expect(
      isAllowedUpgrade(
        request("/?token=secret", "localhost:4317", "https://evil.test"),
        "secret",
        4317,
      ),
    ).toBe(false);
    expect(
      isAllowedUpgrade(request("/?token=secret", "localhost:4317", "not a url"), "secret", 4317),
    ).toBe(false);
    expect(guardUpgrade("secret", 4317)({ req: request("/?token=secret") })).toBe(true);
    createGuardedWebSocketServer(createServer(), "secret", 4317).close();
  });
});
