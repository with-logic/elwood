/**
 * Focused coverage for dev-app adapter selection.
 * Covers PRD §11.
 */

import { describe, expect, test } from "vitest";
import {
  defaultAgentRuntime,
  type SharedSession,
  startAgentSession,
} from "../../src/app/agent-runtime.ts";

describe("app adapter runtime", () => {
  test("default runtime exposes both adapters", () => {
    expect(typeof defaultAgentRuntime.startClaude).toBe("function");
    expect(typeof defaultAgentRuntime.resumeCodex).toBe("function");
  });

  test("C-APP-01 starts Codex through the selected runtime", async () => {
    const session = fakeSession();
    let seenStateDir = "";
    const runtime = {
      startClaude: () => Promise.reject(new Error("wrong adapter")),
      resumeClaude: () => Promise.reject(new Error("wrong adapter")),
      startCodex: (options: { readonly stateDir?: string }) => {
        seenStateDir = options.stateDir ?? "";
        return Promise.resolve(session);
      },
      resumeCodex: () => Promise.reject(new Error("wrong mode")),
    };
    await expect(
      startAgentSession(
        {
          agent: "codex",
          cwd: "/tmp/project",
          stateDir: "/tmp/state",
          size: { cols: 120, rows: 40 },
          hooks: {},
        },
        runtime,
      ),
    ).resolves.toBe(session);
    expect(seenStateDir).toBe("/tmp/state");
  });

  test("C-APP-02 resumes Codex through the selected runtime", async () => {
    const session = fakeSession();
    const runtime = {
      startClaude: () => Promise.reject(new Error("wrong adapter")),
      resumeClaude: () => Promise.reject(new Error("wrong adapter")),
      startCodex: () => Promise.reject(new Error("wrong mode")),
      resumeCodex: () => Promise.resolve(session),
    };
    await expect(
      startAgentSession(
        {
          agent: "codex",
          cwd: "/tmp/project",
          resumeSessionId: "s1",
          size: { cols: 120, rows: 40 },
          hooks: {},
        },
        runtime,
      ),
    ).resolves.toBe(session);
  });
});

function fakeSession(): SharedSession {
  return {
    elwoodSessionId: "s1",
    cwd: "/tmp/project",
    status: "running",
    warnings: [],
    terminal: fakeTerminal() as never,
    on: () => () => {},
    sendPrompt: () => Promise.resolve(),
    sendMessage: () => Promise.resolve(),
    sendKeys: () => Promise.resolve(),
    resize: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    kill: () => Promise.resolve(),
    teardown: () => Promise.resolve(),
  };
}

function fakeTerminal() {
  return { snapshot: () => ({ text: "screen" }), settled: () => Promise.resolve() };
}
