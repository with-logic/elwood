/**
 * Adapter launch mapping coverage (PRD §12A.2, C-CLI-05/C-CLI-06/C-CLI-08).
 */

import { describe, expect, test } from "vitest";
import { type CliLaunchDependencies, createCliLaunch } from "../../src/cli/session-launch.ts";
import type { EffectiveRunRequest } from "../../src/cli/types.ts";

function request(
  agent: "claude" | "codex",
  overrides: Partial<EffectiveRunRequest> = {},
): EffectiveRunRequest {
  return {
    agent,
    output: "text",
    outputExplicit: false,
    trust: false,
    stateDir: "/state",
    verbose: false,
    stream: false,
    cwd: "/workspace",
    images: [],
    prompt: "go",
    keep: false,
    ephemeral: false,
    ...(agent === "claude"
      ? { permissionMode: "plan" }
      : { sandbox: "read-only", approvalPolicy: "on-request" }),
    ...overrides,
  };
}

function harness() {
  const calls: Array<{ readonly name: string; readonly options: unknown; readonly id?: string }> =
    [];
  const fail = (name: string, options: unknown, id?: string): Promise<never> => {
    calls.push({ name, options, ...(id === undefined ? {} : { id }) });
    return Promise.reject(new Error(name));
  };
  const dependencies: CliLaunchDependencies = {
    startClaude: (options, id) => fail("startClaude", options, id),
    resumeClaude: (options) => fail("resumeClaude", options),
    startCodex: (options, id) => fail("startCodex", options, id),
    resumeCodex: (options) => fail("resumeCodex", options),
  };
  return { calls, dependencies };
}

describe("CLI adapter launch mapping", () => {
  test("new Claude carries posture/model/effort and uses the preallocated identity", async () => {
    const h = harness();
    const launch = createCliLaunch(
      request("claude", { model: "sonnet", reasoningEffort: "high" }),
      "new-claude",
      h.dependencies,
    );
    await expect(launch()).rejects.toThrow("startClaude");
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
          model: "sonnet",
        },
      },
    ]);
  });

  test("exact Claude resume has no start or model fallback", async () => {
    const h = harness();
    const launch = createCliLaunch(request("claude", { resume: "saved" }), "saved", h.dependencies);
    await expect(launch()).rejects.toThrow("resumeClaude");
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

  test("new Codex carries posture/model/effort and uses the preallocated identity", async () => {
    const h = harness();
    const launch = createCliLaunch(
      request("codex", { model: "gpt", reasoningEffort: "minimal" }),
      "new-codex",
      h.dependencies,
    );
    await expect(launch()).rejects.toThrow("startCodex");
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

  test("exact Codex resume has no start or model fallback", async () => {
    const h = harness();
    const launch = createCliLaunch(request("codex", { resume: "saved" }), "saved", h.dependencies);
    await expect(launch()).rejects.toThrow("resumeCodex");
    expect(h.calls[0]).toEqual({
      name: "resumeCodex",
      options: {
        cwd: "/workspace",
        stateDir: "/state",
        autotrust: false,
        sandbox: "read-only",
        approvalPolicy: "on-request",
        elwoodSessionId: "saved",
      },
    });
  });

  test("new launches supply defaults and omit absent model and invalid effort", async () => {
    const claude = harness();
    const { permissionMode: _permission, ...claudeRequest } = request("claude", {
      reasoningEffort: "invalid",
    });
    await expect(
      createCliLaunch(claudeRequest as EffectiveRunRequest, "c", claude.dependencies)(),
    ).rejects.toThrow("startClaude");
    expect(claude.calls[0]).toMatchObject({ options: { permissionMode: "dontAsk" } });
    expect(claude.calls[0]?.options).not.toHaveProperty("model");
    expect(claude.calls[0]?.options).not.toHaveProperty("reasoningEffort");

    const codex = harness();
    const {
      sandbox: _sandbox,
      approvalPolicy: _approval,
      ...codexRequest
    } = request("codex", {
      reasoningEffort: "invalid",
    });
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
