/**
 * Interactive-mode argument assembly through the adapters' shared launch builders.
 * Covers PRD §12A.9 and C-CLI-23.
 */

import { describe, expect, test } from "vitest";
import { interactiveLaunch } from "../../src/cli/interactive/launch.ts";
import type { EffectiveRunRequest } from "../../src/cli/types.ts";
import { createSessionRecord, updateSessionResumeId } from "../../src/state/store.ts";
import { effectiveRequest, fakeResolution } from "./main-fakes.ts";

function withSources(
  request: EffectiveRunRequest,
  sources: Partial<Record<"permissionMode" | "sandbox" | "approvalPolicy", string>>,
): EffectiveRunRequest {
  return { ...request, resolution: fakeResolution(sources) };
}

describe("interactiveLaunch", () => {
  test("C-CLI-23 omits built-in posture and passes explicit Claude settings as native flags", () => {
    const quiet = withSources(effectiveRequest({ agent: "claude", permissionMode: "dontAsk" }), {});
    expect(interactiveLaunch(quiet, undefined)).toEqual({
      agent: "claude",
      command: "claude",
      args: [],
      cwd: "/work",
    });
    const explicit = withSources(
      effectiveRequest({
        agent: "claude",
        permissionMode: "plan",
        model: "opus",
        reasoningEffort: "high",
      }),
      { permissionMode: "--claude-permission-mode" },
    );
    expect(interactiveLaunch(explicit, undefined).args).toEqual([
      "--model",
      "opus",
      "--effort",
      "high",
      "--permission-mode",
      "plan",
    ]);
  });

  test("C-CLI-23 without resolution provenance no posture is forwarded", () => {
    const request = effectiveRequest({ agent: "claude", permissionMode: "dontAsk" });
    expect(interactiveLaunch(request, undefined).args).toEqual([]);
    const codex = effectiveRequest({ sandbox: "workspace-write", approvalPolicy: "never" });
    expect(interactiveLaunch(codex, undefined).args).toEqual(["--cd", "/work"]);
  });

  test("C-CLI-23 resumes a stored Claude record with merged posture and its conversation id", () => {
    const stored = updateSessionResumeId(
      {
        ...createSessionRecord({ cwd: "/stored", id: "abc" }),
        claude: { launch: { permissionMode: "acceptEdits", allowedTools: ["Bash"], tools: [] } },
      },
      "claude",
      "conv-9",
    );
    const request = withSources(
      effectiveRequest({ agent: "claude", cwd: "/stored", permissionMode: "plan" }),
      { permissionMode: "--claude-permission-mode" },
    );
    expect(interactiveLaunch(request, stored)).toEqual({
      agent: "claude",
      command: "claude",
      args: [
        "--resume",
        "conv-9",
        "--permission-mode",
        "plan",
        "--allowedTools",
        "Bash",
        "--tools",
        "",
      ],
      cwd: "/stored",
    });
    const missing = createSessionRecord({ cwd: "/stored", id: "abc" });
    expect(() => interactiveLaunch(request, missing)).toThrow(
      "Cannot resume Claude without a Claude session id.",
    );
  });

  test("C-CLI-23 maps Codex posture, effort, and resume through the shared builder", () => {
    const fresh = withSources(
      effectiveRequest({
        model: "gpt-5",
        reasoningEffort: "high",
        sandbox: "read-only",
        approvalPolicy: "on-request",
      }),
      { sandbox: "--codex-sandbox", approvalPolicy: "ELWOOD_CODEX_APPROVAL_POLICY" },
    );
    expect(interactiveLaunch(fresh, undefined)).toEqual({
      agent: "codex",
      command: "codex",
      args: [
        "--model",
        "gpt-5",
        "--sandbox",
        "read-only",
        "--ask-for-approval",
        "on-request",
        "--cd",
        "/work",
        "-c",
        'model_reasoning_effort="high"',
      ],
      cwd: "/work",
    });
    const stored = updateSessionResumeId(
      {
        ...createSessionRecord({ cwd: "/stored", id: "abc", adapter: "codex" }),
        codex: { launch: { sandbox: "danger-full-access", approvalPolicy: "never" } },
      },
      "codex",
      "thread-1",
    );
    const resumed = withSources(effectiveRequest({ cwd: "/stored" }), {});
    expect(interactiveLaunch(resumed, stored).args).toEqual([
      "resume",
      "thread-1",
      "--sandbox",
      "danger-full-access",
      "--ask-for-approval",
      "never",
      "--cd",
      "/stored",
    ]);
    expect(() =>
      interactiveLaunch(
        resumed,
        createSessionRecord({ cwd: "/stored", id: "x", adapter: "codex" }),
      ),
    ).toThrow("Cannot resume Codex without a Codex session id.");
  });
});
