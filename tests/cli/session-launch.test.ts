/**
 * Adapter launch mapping coverage (PRD §12A.2/§12A.5, C-CLI-05/C-CLI-06/C-CLI-08/C-CLI-15).
 */

import { describe, expect, test } from "vitest";
import { type CliLaunchDependencies, createCliLaunch } from "../../src/cli/session/launch.ts";
import type { EffectiveRunRequest } from "../../src/cli/types.ts";
import { type EffectiveRequestOverrides, effectiveRequest } from "./main-fakes.ts";

function request(
  agent: "claude" | "codex",
  overrides: EffectiveRequestOverrides = {},
): EffectiveRunRequest {
  return effectiveRequest({
    agent,
    trust: false,
    cwd: "/workspace",
    ...(agent === "claude"
      ? { permissionMode: "plan" }
      : { sandbox: "read-only", approvalPolicy: "on-request" }),
    ...overrides,
  });
}

function harness() {
  const calls: Array<{ readonly name: string; readonly options: unknown; readonly id?: string }> =
    [];
  const prepared: string[] = [];
  const fail = (name: string, options: unknown, id?: string): Promise<never> => {
    calls.push({ name, options, ...(id === undefined ? {} : { id }) });
    return Promise.reject(new Error(name));
  };
  const dependencies: CliLaunchDependencies = {
    prepareStateRoot: (stateDir) => prepared.push(stateDir),
    startClaude: (options, id) => fail("startClaude", options, id),
    resumeClaude: (options) => fail("resumeClaude", options),
    startCodex: (options, id) => fail("startCodex", options, id),
    resumeCodex: (options) => fail("resumeCodex", options),
  };
  return { calls, dependencies, prepared };
}

describe("CLI adapter launch mapping", () => {
  test("C-CLI-06 new Claude carries posture/model/effort and uses the preallocated identity", async () => {
    const h = harness();
    const launch = createCliLaunch(
      request("claude", {
        model: "sonnet",
        reasoningEffort: "high",
        initialSize: { cols: 117, rows: 39 },
      }),
      "new-claude",
      h.dependencies,
    );
    await expect(launch()).rejects.toThrow("startClaude");
    expect(h.prepared).toEqual(["/state"]);
    expect(h.calls).toEqual([
      {
        name: "startClaude",
        id: "new-claude",
        options: {
          cwd: "/workspace",
          stateDir: "/state",
          autotrust: false,
          permissionMode: "plan",
          reasoningEffort: "high",
          initialSize: { cols: 117, rows: 39 },
          model: "sonnet",
        },
      },
    ]);
  });

  test("C-CLI-08 exact Claude resume has no start or model fallback", async () => {
    const h = harness();
    const launch = createCliLaunch(request("claude", { resume: "saved" }), "saved", h.dependencies);
    await expect(launch()).rejects.toThrow("resumeClaude");
    expect(h.prepared).toEqual([]);
    expect(h.calls).toEqual([
      {
        name: "resumeClaude",
        options: {
          cwd: "/workspace",
          stateDir: "/state",
          autotrust: false,
          permissionMode: "plan",
          elwoodSessionId: "saved",
        },
      },
    ]);
  });

  test("C-CLI-06 new Codex carries posture/model/effort and uses the preallocated identity", async () => {
    const h = harness();
    const launch = createCliLaunch(
      request("codex", { model: "gpt", reasoningEffort: "minimal" }),
      "new-codex",
      h.dependencies,
    );
    await expect(launch()).rejects.toThrow("startCodex");
    expect(h.prepared).toEqual(["/state"]);
    expect(h.calls[0]).toEqual({
      name: "startCodex",
      id: "new-codex",
      options: {
        cwd: "/workspace",
        stateDir: "/state",
        autotrust: false,
        sandbox: "read-only",
        approvalPolicy: "on-request",
        reasoningEffort: "minimal",
        model: "gpt",
      },
    });
  });

  test("C-CLI-08 exact Codex resume has no start or model fallback", async () => {
    const h = harness();
    const launch = createCliLaunch(
      request("codex", { resume: "saved", initialSize: { cols: 91, rows: 27 } }),
      "saved",
      h.dependencies,
    );
    await expect(launch()).rejects.toThrow("resumeCodex");
    expect(h.prepared).toEqual([]);
    expect(h.calls[0]).toEqual({
      name: "resumeCodex",
      options: {
        cwd: "/workspace",
        stateDir: "/state",
        autotrust: false,
        sandbox: "read-only",
        approvalPolicy: "on-request",
        initialSize: { cols: 91, rows: 27 },
        elwoodSessionId: "saved",
      },
    });
  });

  test("C-CLI-06 new launches supply defaults and omit an absent model and effort", async () => {
    const claude = harness();
    const { permissionMode: _permission, ...claudeRequest } = request("claude");
    await expect(
      createCliLaunch(claudeRequest as EffectiveRunRequest, "c", claude.dependencies)(),
    ).rejects.toThrow("startClaude");
    expect(claude.calls[0]).toMatchObject({ options: { permissionMode: "dontAsk" } });
    expect(claude.calls[0]?.options).not.toHaveProperty("model");
    expect(claude.calls[0]?.options).not.toHaveProperty("reasoningEffort");

    const codex = harness();
    const { sandbox: _sandbox, approvalPolicy: _approval, ...codexRequest } = request("codex");
    await expect(
      createCliLaunch(codexRequest as EffectiveRunRequest, "x", codex.dependencies)(),
    ).rejects.toThrow("startCodex");
    expect(codex.calls[0]).toMatchObject({
      options: { sandbox: "workspace-write", approvalPolicy: "never" },
    });
    expect(codex.calls[0]?.options).not.toHaveProperty("model");
    expect(codex.calls[0]?.options).not.toHaveProperty("reasoningEffort");
  });
});
