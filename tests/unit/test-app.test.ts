/**
 * The stdin-driven local test app (PRD §11, C-APP-01..07): argument parsing, session
 * start/resume through an injectable runtime, event logging, and hook handler coverage.
 */

import { describe, expect, test } from "vitest";
import {
  createLiveHookHandlers,
  parseTestAppArgs,
  runTestApp,
  summarizeHookResult,
} from "../../dev/test-app.ts";
import { claudeHookEventNames } from "../../src/claude/hooks/names.ts";
import { codexHookEventNames } from "../../src/codex/hooks/names.ts";
import { fakeSharedSession } from "../helpers/fake-shared-session.ts";

describe("local test app", () => {
  test("C-APP-01 C-APP-02 parses start and resume launch options", () => {
    expect(parseTestAppArgs(["--cwd", "/tmp/project", "--size", "80x24"])).toEqual({
      agent: "claude",
      cwd: "/tmp/project",
      size: { cols: 80, rows: 24 },
    });
    expect(
      parseTestAppArgs(["--cwd", "/tmp/project", "--state-dir", "/tmp/state", "--resume", "e1"]),
    ).toEqual({
      agent: "claude",
      cwd: "/tmp/project",
      stateDir: "/tmp/state",
      elwoodSessionId: "e1",
      size: { cols: 189, rows: 48 },
    });
    expect(parseTestAppArgs(["--agent", "codex", "--cwd", "/tmp/project"]).agent).toBe("codex");
    expect(parseTestAppArgs(["--cwd", "/tmp/project", "--size", "bad"]).size).toEqual({
      cols: 189,
      rows: 48,
    });
  });

  test("C-APP-03 C-APP-04 C-APP-05 C-APP-07 runs against an injectable session", async () => {
    const session = fakeSharedSession("s1", { cwd: "/tmp/project" });
    const stdout = new Sink();
    const stderr = new Sink();
    const runtime = {
      startClaude: async () => session,
      resumeClaude: async () => session,
      startCodex: async () => session,
      resumeCodex: async () => session,
    };
    const id = await runTestApp(
      ["--cwd", "/tmp/project"],
      { stdin: chunks(["hello\nworld", Buffer.from("/resize 100x20")]), stdout, stderr },
      runtime,
    );
    session.emit("terminal:data", { elwoodSessionId: "s1", data: "screen" });
    session.emit("terminal:exit", { elwoodSessionId: "s1", exitCode: 0 });
    session.emit("status", { elwoodSessionId: "s1", status: "ready" });
    session.emit("activity", {
      elwoodSessionId: "s1",
      agent: "codex",
      source: "transcript",
      kind: "web_search",
      label: "search",
    });
    session.emit("warning", { code: "mcp_server_not_logged_in" } as never);
    session.emit("hookError", {
      elwoodSessionId: "s1",
      hookEventName: "Stop",
      category: "timeout",
      message: "timed out",
    });
    expect(id).toBe("s1");
    expect(session.prompts).toEqual(["hello\nworld"]);
    expect(session.sizes).toEqual([{ cols: 100, rows: 20 }]);
    expect(stdout.text).toContain("screen");
    expect(stderr.text).toContain("[terminal] exit 0");
    expect(stderr.text).toContain("[status] ready");
    expect(stderr.text).toContain("[activity] web_search search");
    expect(stderr.text).toContain("[warning] mcp_server_not_logged_in");
    expect(stderr.text).toContain("[hookError] Stop timeout");
  });

  test("C-APP-02 resumes through the injectable runtime", async () => {
    const session = fakeSharedSession("s1", { cwd: "/tmp/project" });
    const runtime = {
      startClaude: () => Promise.reject(new Error("should resume")),
      resumeClaude: () => Promise.resolve(session),
      startCodex: () => Promise.reject(new Error("should not start codex")),
      resumeCodex: () => Promise.reject(new Error("should not resume codex")),
    };
    const id = await runTestApp(
      ["--cwd", "/tmp/project", "--resume", "s1"],
      { stdin: chunks([]), stdout: new Sink(), stderr: new Sink() },
      runtime,
    );
    expect(id).toBe("s1");
  });

  test("C-APP-05 live hook handlers log every hook event", () => {
    const stderr = new Sink();
    const handlers = createLiveHookHandlers("claude", stderr);
    handlers.Stop?.({ hook_event_name: "Stop", session_id: "claude-1", cwd: "/tmp/project" });
    expect(Object.keys(handlers).sort()).toEqual([...claudeHookEventNames].sort());
    expect(stderr.text).toContain("[hook] Stop no decision");
    const codex = createLiveHookHandlers("codex", stderr);
    codex.Stop?.({
      hook_event_name: "Stop",
      session_id: "codex-1",
      cwd: "/tmp/project",
      model: "gpt-5.3-codex",
      turn_id: "turn-1",
      stop_hook_active: false,
    });
    expect(Object.keys(codex).sort()).toEqual([...codexHookEventNames].sort());
    expect(stderr.text).toContain("[hook] Stop no decision");
  });

  test("C-APP-06 summarizes handler result semantics", () => {
    expect(summarizeHookResult(undefined)).toBe("no decision");
    expect(summarizeHookResult({ permissionDecision: "allow" })).toBe("allow");
    expect(summarizeHookResult({ behavior: "deny" })).toBe("deny");
    expect(summarizeHookResult({ decision: "block", reason: "no" })).toBe("block");
    expect(summarizeHookResult({ additionalContext: "context" })).toBe("context");
    expect(summarizeHookResult({ action: "cancel" })).toBe("cancel");
    expect(summarizeHookResult({ retry: true })).toBe("retry");
    expect(summarizeHookResult({ worktreePath: "/tmp/w" })).toBe("worktree");
    expect(summarizeHookResult({ continue: false, stopReason: "done" })).toBe("no decision");
  });
});

async function* chunks(
  values: readonly (string | Uint8Array)[],
): AsyncIterable<string | Uint8Array> {
  for (const value of values) {
    await Promise.resolve();
    yield value;
  }
}

class Sink {
  text = "";

  write(chunk: string): void {
    this.text += chunk;
  }
}
