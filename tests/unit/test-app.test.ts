/**
 * Conformance tests for the local developer test app.
 * Covers PRD §11.
 */

import { describe, expect, test } from "bun:test";
import {
  createLiveHookHandlers,
  parseTestAppArgs,
  runTestApp,
  summarizeHookResult,
} from "../../src/app/test-app.ts";
import type { ClaudeSession, ElwoodEventHandler, ElwoodEventName } from "../../src/index.ts";

describe("local test app", () => {
  test("C-APP-01 C-APP-02 parses start and resume launch options", () => {
    expect(parseTestAppArgs(["--cwd", "/tmp/project", "--size", "80x24"])).toEqual({
      cwd: "/tmp/project",
      size: { cols: 80, rows: 24 },
    });
    expect(
      parseTestAppArgs(["--cwd", "/tmp/project", "--state-dir", "/tmp/state", "--resume", "e1"]),
    ).toEqual({
      cwd: "/tmp/project",
      stateDir: "/tmp/state",
      resumeSessionId: "e1",
      size: { cols: 120, rows: 40 },
    });
    expect(parseTestAppArgs(["--cwd", "/tmp/project", "--size", "bad"]).size).toEqual({
      cols: 120,
      rows: 40,
    });
  });

  test("C-APP-03 C-APP-04 C-APP-05 C-APP-07 runs against an injectable session", async () => {
    const session = new FakeSession();
    const stdout = new Sink();
    const stderr = new Sink();
    const runtime = {
      startClaude: async () => session,
      resumeClaude: async () => session,
    };
    const id = await runTestApp(
      ["--cwd", "/tmp/project"],
      { stdin: chunks(["hello\nworld", "/resize 100x20"]), stdout, stderr },
      runtime,
    );
    session.emit("terminal:data", { elwoodSessionId: "s1", data: "screen" });
    session.emit("terminal:exit", { elwoodSessionId: "s1", exitCode: 0 });
    session.emit("status", { elwoodSessionId: "s1", status: "ready" });
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
    expect(stderr.text).toContain("[hookError] Stop timeout");
  });

  test("C-APP-02 resumes through the injectable runtime", async () => {
    const session = new FakeSession();
    const runtime = {
      startClaude: () => Promise.reject(new Error("should resume")),
      resumeClaude: () => Promise.resolve(session),
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
    const handlers = createLiveHookHandlers(stderr);
    handlers.Stop?.({ hook_event_name: "Stop", session_id: "claude-1", cwd: "/tmp/project" });
    expect(Object.keys(handlers)).toHaveLength(29);
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
  });
});

async function* chunks(values: readonly string[]): AsyncIterable<string> {
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

class FakeSession implements ClaudeSession {
  readonly elwoodSessionId = "s1";
  readonly cwd = "/tmp/project";
  readonly status = "running";
  readonly prompts: string[] = [];
  readonly sizes: { readonly cols: number; readonly rows: number }[] = [];
  private readonly handlers = new Map<ElwoodEventName, ElwoodEventHandler<ElwoodEventName>[]>();

  on<E extends ElwoodEventName>(event: E, handler: ElwoodEventHandler<E>) {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler as ElwoodEventHandler<ElwoodEventName>);
    this.handlers.set(event, handlers);
    return () => this.off(event, handler);
  }

  off<E extends ElwoodEventName>(event: E, handler: ElwoodEventHandler<E>): void {
    this.handlers.set(
      event,
      (this.handlers.get(event) ?? []).filter((entry) => entry !== handler),
    );
  }

  emit<E extends ElwoodEventName>(event: E, payload: Parameters<ElwoodEventHandler<E>>[0]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(payload as never);
    }
  }

  sendPrompt(prompt: string): Promise<void> {
    this.prompts.push(prompt);
    return Promise.resolve();
  }

  sendKeys(): Promise<void> {
    return Promise.resolve();
  }

  resize(size: { readonly cols: number; readonly rows: number }): Promise<void> {
    this.sizes.push(size);
    return Promise.resolve();
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }

  kill(): Promise<void> {
    return Promise.resolve();
  }

  teardown(): Promise<void> {
    return Promise.resolve();
  }
}
