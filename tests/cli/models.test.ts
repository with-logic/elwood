/**
 * Model-listing executor: picker rows, protocols, and lifecycle failure mapping.
 * Covers PRD §12A.10 and C-CLI-26.
 */

import { describe, expect, test } from "vitest";
import { executeModels } from "../../src/cli/models/index.ts";
import { AsyncOutputSink } from "../../src/cli/stream.ts";
import type { EffectiveRunRequest } from "../../src/cli/types.ts";
import type { AgentModelOption } from "../../src/core/models/rows.ts";
import { effectiveRequest } from "./main-fakes.ts";
import { FakeCliSession, FakeClock, FakeSignals, MemoryWriter } from "./run-fakes.ts";

const rows: readonly AgentModelOption[] = [
  {
    id: "gpt-5",
    label: "gpt-5",
    description: "Flagship \u001b[31mmodel",
    isCurrent: true,
    isDefault: false,
    raw: "1. gpt-5 (current)  Flagship",
  },
  {
    id: "gpt-5-mini",
    label: "gpt-5-mini",
    isCurrent: false,
    isDefault: true,
    raw: "2. gpt-5-mini (default)",
  },
];

function harness(overrides: Partial<EffectiveRunRequest> = {}) {
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();
  const session = new FakeCliSession();
  session.underlying.listModels = () => Promise.resolve(rows);
  const signals = new FakeSignals();
  const clock = new FakeClock();
  const request = effectiveRequest({ prompt: "", keep: true, ...overrides });
  const run = () =>
    executeModels(
      request,
      session,
      { stdout: new AsyncOutputSink(stdout), stderr: new AsyncOutputSink(stderr) },
      { signals, clock },
    );
  return { stdout, stderr, session, signals, clock, run };
}

describe("executeModels", () => {
  test("C-CLI-26 prints an aligned table marking current and default, then tears down", async () => {
    const h = harness();
    expect(await h.run()).toBe(0);
    expect(h.stdout.value).toBe(
      [
        "CURRENT  ID          LABEL       DEFAULT    DESCRIPTION",
        "*        gpt-5       gpt-5                  Flagship model",
        "         gpt-5-mini  gpt-5-mini  (default)",
        "",
      ].join("\n"),
    );
    expect(h.session.teardowns).toBe(1);
    expect(h.session.closes).toBe(0);
    expect(h.signals.unbound).toBe(true);
    expect(h.stderr.value).toBe("");
  });

  test("C-CLI-26 emits one sanitized JSON models document", async () => {
    const h = harness({ output: "json" });
    expect(await h.run()).toBe(0);
    const document = JSON.parse(h.stdout.value);
    expect(document).toMatchObject({ schemaVersion: 1, type: "models", agent: "codex" });
    expect(document.models).toHaveLength(2);
    expect(document.models[0].description).toBe("Flagship model");
    expect(document.models[1]).not.toHaveProperty("description");
    expect(h.stdout.value.endsWith("\n")).toBe(true);
  });

  test("C-CLI-26 maps a picker failure to an error record with cleanup and status 1", async () => {
    const h = harness({ output: "json" });
    h.session.underlying.listModels = () => Promise.reject(new Error("picker failed"));
    expect(await h.run()).toBe(1);
    const document = JSON.parse(h.stdout.value);
    expect(document).toMatchObject({
      type: "error",
      agent: "codex",
      response: "",
      sessionId: null,
      cleanup: { action: "teardown", status: "succeeded" },
      error: { code: "runtime_error", message: "Agent execution failed." },
    });
    expect(h.session.teardowns).toBe(1);
  });

  test("C-CLI-26 text failures go to stderr and cleanup failure changes the status", async () => {
    const h = harness();
    h.session.cleanupError = new Error("nope");
    expect(await h.run()).toBe(1);
    expect(h.stdout.value).toBe("");
    expect(h.stderr.value).toBe("elwood: Cleanup failed.\n");
  });

  test("C-CLI-26 a deadline during launch times out with status 124", async () => {
    const h = harness({ timeoutMs: 50 });
    let release: (() => void) | undefined;
    h.session.underlying.listModels = () =>
      new Promise((resolve) => {
        release = () => resolve(rows);
      });
    const pending = h.run();
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.clock.value = 60;
    h.clock.fire();
    expect(await pending).toBe(124);
    expect(h.stderr.value).toBe("elwood: Timed out.\n");
    expect(h.session.interrupts).toBe(1);
    release?.();
  });

  test("C-CLI-26 a deadline while the agent is still starting also times out", async () => {
    const h = harness({ timeoutMs: 50, output: "json" });
    h.session.start = () => new Promise(() => undefined);
    const pending = h.run();
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.clock.value = 60;
    h.clock.fire();
    expect(await pending).toBe(124);
    expect(JSON.parse(h.stdout.value).error.code).toBe("timeout");
    expect(h.session.teardowns).toBe(1);
  });

  test("C-CLI-26 SIGINT interrupts with status 130 and a blocked prompt fails as blocked_prompt", async () => {
    const interrupted = harness({ output: "json" });
    interrupted.session.underlying.listModels = () => {
      interrupted.signals.emit();
      return new Promise(() => undefined);
    };
    expect(await interrupted.run()).toBe(130);
    expect(JSON.parse(interrupted.stdout.value).error.code).toBe("interrupted");

    const blocked = harness({ agent: "codex", trust: false });
    blocked.session.underlying.listModels = () => {
      blocked.session.emitActivity({ kind: "attention", label: "workspace_trust" });
      return new Promise(() => undefined);
    };
    expect(await blocked.run()).toBe(1);
    expect(blocked.stderr.value).toBe("elwood: Blocked prompt: workspace_trust.\n");
    expect(blocked.session.kills).toBe(1);
  });

  test("C-CLI-26 a Claude listing needs no update guard and ignores status events", async () => {
    const h = harness({ agent: "claude", output: "json" });
    h.session.underlying.listModels = () => {
      h.session.emitter.emit("status", { elwoodSessionId: "s1", status: "running" });
      return Promise.resolve(rows);
    };
    expect(await h.run()).toBe(0);
    expect(JSON.parse(h.stdout.value).agent).toBe("claude");
    expect(h.stderr.value).toBe("");
  });

  test("C-CLI-26 quiet warnings do not hide premature exit", async () => {
    const h = harness();
    h.session.underlying.listModels = () => {
      h.session.emitter.emit("warning", {
        elwoodSessionId: "s1",
        agent: "codex",
        source: "lifecycle",
        code: "version_unparseable",
        severity: "warning",
        message: "odd \u001b[1mversion",
        raw: "",
      });
      h.session.emitter.emit("terminal:exit", { elwoodSessionId: "s1", exitCode: 0 });
      return new Promise(() => undefined);
    };
    expect(await h.run()).toBe(1);
    expect(h.stderr.value).toBe("elwood: Agent exited before completing the turn.\n");
  });
});
