/**
 * The model probe's refusals of load rows and extension prompts (PRD §5.3, §10, C-CLAUDE-29):
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

// Taken before any test fakes the clock, to bound a wait in real time.
const realSetTimeout = globalThis.setTimeout;

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
] as const)("C-CLAUDE-29 the probe refuses %s", async (_, frame, category, reason) => {
  const end = await probeEnd(await probeShown("2.1.332", (cwd) => atLaunchPath(frame, cwd)));
  expect(end).toEqual(refused(reason, category));
  expect(end.error).toMatchObject({ message: expect.stringMatching(remedy) });
});

test("C-CLAUDE-29 the probe refuses a workspace prompt it cannot verify once its budget runs out", async () => {
  // Faked once the probe has spawned, so its five-second trust budget passes at once. After that
  // the faked clock keeps pace with real time, so the probe's teardown runs as it would.
  const beforeShow = () =>
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
  const shown = await probeShown("2.1.332", (cwd) => atLaunchPath(claudeSettingsEnvPrompt, cwd), {
    beforeShow,
  });
  const ending = probeEnd(shown);
  for (let elapsed = 0; elapsed <= gateBudgetMs; elapsed += gateBudgetMs / 10) {
    await vi.advanceTimersByTimeAsync(gateBudgetMs / 10);
  }
  // A probe that did not refuse is still in its 60 s readiness wait, so bound the teardown in
  // real time, well inside the test's own timeout.
  const outlasted = new Promise<"outlasted">((resolve) => {
    realSetTimeout(() => resolve("outlasted"), 5_000).unref();
  });
  const end = await Promise.race([ending, outlasted]);
  if (end === "outlasted") expect.fail("the probe refused once its trust budget ran out");
  expect(end).toEqual(
    refused(/^Elwood cannot verify Claude's workspace trust prompt/, "workspace_unverified"),
  );
  expect(end.error).toMatchObject({ message: expect.stringMatching(remedy) });
});
