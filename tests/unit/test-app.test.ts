import { describe, expect, test } from "bun:test";
import type {
  CommonEventHandler,
  CommonEventName,
  SharedSession,
} from "../../src/app/agent-runtime.ts";
import {
  createLiveHookHandlers,
  parseTestAppArgs,
  runTestApp,
  summarizeHookResult,
} from "../../src/app/test-app.ts";

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
      resumeSessionId: "e1",
      size: { cols: 120, rows: 40 },
    });
    expect(parseTestAppArgs(["--agent", "codex", "--cwd", "/tmp/project"]).agent).toBe("codex");
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
    expect(stderr.text).toContain("[hookError] Stop timeout");
  });

  test("C-APP-02 resumes through the injectable runtime", async () => {
    const session = new FakeSession();
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
    expect(Object.keys(handlers)).toHaveLength(29);
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
    expect(Object.keys(codex)).toHaveLength(10);
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
    expect(summarizeHookResult({ stopReason: "done" })).toBe("no decision");
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

class FakeSession implements SharedSession {
  readonly elwoodSessionId = "s1";
  readonly cwd = "/tmp/project";
  readonly status = "running";
  readonly prompts: string[] = [];
  readonly sizes: { readonly cols: number; readonly rows: number }[] = [];
  private readonly handlers = new Map<CommonEventName, CommonEventHandler<CommonEventName>[]>();

  on<E extends CommonEventName>(event: E, handler: CommonEventHandler<E>) {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler as CommonEventHandler<CommonEventName>);
    this.handlers.set(event, handlers);
    return () => this.off(event, handler);
  }

  off<E extends CommonEventName>(event: E, handler: CommonEventHandler<E>): void {
    this.handlers.set(
      event,
      (this.handlers.get(event) ?? []).filter((entry) => entry !== handler),
    );
  }

  emit<E extends CommonEventName>(event: E, payload: Parameters<CommonEventHandler<E>>[0]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(payload as never);
    }
  }

  sendPrompt(prompt: string): Promise<void> {
    this.prompts.push(prompt);
    return Promise.resolve();
  }

  sendMessage(message: string): Promise<void> {
    return this.sendPrompt(message);
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
