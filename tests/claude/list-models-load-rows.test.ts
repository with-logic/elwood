/**
 * The model probe's refusals of load rows and extension prompts (PRD §5.3, §10, C-CLAUDE-27):
 * each rejects with `claude_start_failed`, its own `details.category`, and a message that names
 * why and the remedy, writes nothing, and tears the probe down.
 */
import { afterEach, expect, test, vi } from "vitest";
import { gateBudgetMs } from "../../src/core/trust/deadline.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";
import {
  atLaunchPath,
  claudeMcpServerPrompt,
  claudeSettingsEnvPrompt,
} from "../helpers/claude-workspace-trust-screen.ts";
import { resetFakes } from "./helpers.ts";
import { probeEnd, probeShown, refused } from "./probe-trust-helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  resetFakes();
});

const remedy =
  /; listing models does not answer that prompt\. List models from a folder Claude already trusts, with no trust prompts left to answer\.$/;

test.each([
  [
    "a load row naming MCP servers",
    capturedFrame("claude-2.1.332/trust/workspace-mcp-120"),
    "workspace_mcp_servers",
    /^Claude's workspace trust prompt says this folder declares MCP servers/,
  ],
  [
    "a load row naming settings files alone",
    capturedFrame("claude-2.1.332/trust/workspace-settings-120"),
    "workspace_settings",
    /^Claude's workspace trust prompt says this folder has project settings, which can enable plugins that run commands/,
  ],
  [
    "a load row naming settings that run commands and MCP servers",
    capturedFrame("claude-2.1.332/trust/workspace-hooks-mcp-120"),
    "workspace_hooks",
    /^Claude's workspace trust prompt says this folder has hooks/,
  ],
  [
    "Claude's MCP server prompt",
    claudeMcpServerPrompt,
    "workspace_mcp_servers",
    /^Claude asks to use an MCP server this folder declares/,
  ],
  [
    "Claude's plugin prompt",
    "Do you trust the plugin?\n1. Yes, trust it\n2. No",
    "workspace_plugins",
    /^Claude asks to trust a plugin/,
  ],
  [
    "Claude's skill prompt",
    "Load this skill?\n1. Yes, load this skill\n2. No",
    "workspace_skills",
    /^Claude asks to load a skill/,
  ],
] as const)("C-CLAUDE-27 the probe refuses %s", async (_, frame, category, reason) => {
  const end = await probeEnd(await probeShown("2.1.332", (cwd) => atLaunchPath(frame, cwd)));
  expect(end).toEqual(refused(reason, category));
  expect(end.error).toMatchObject({ message: expect.stringMatching(remedy) });
});

test("C-CLAUDE-27 the probe refuses a workspace prompt it cannot verify once its budget runs out", async () => {
  // Faked once the probe has spawned, so its five-second trust budget passes at once.
  const beforeShow = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const shown = await probeShown("2.1.332", (cwd) => atLaunchPath(claudeSettingsEnvPrompt, cwd), {
    beforeShow,
  });
  const ending = probeEnd(shown);
  let ended = false;
  void ending.finally(() => {
    ended = true;
  });
  // The budget, then the teardown the refusal starts, each on the faked clock.
  for (let step = 0; !ended && step < 100; step += 1) {
    await vi.advanceTimersByTimeAsync(gateBudgetMs / 10);
  }
  const end = await ending;
  expect(end).toEqual(
    refused(/^Elwood cannot verify Claude's workspace trust prompt/, "workspace_unverified"),
  );
  expect(end.error).toMatchObject({ message: expect.stringMatching(remedy) });
});
