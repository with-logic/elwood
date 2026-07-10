/**
 * Compile-time regression guards for the trust/startup discriminated unions.
 * Locks in PRD §5.1 and §5.4 (C-CLAUDE-10/11/14, C-CODEX-11/12/15): these types
 * make invalid states unrepresentable, and each `@ts-expect-error` below turns
 * into an UNUSED-directive typecheck failure if the exported types are ever
 * widened back to admit the invalid state it rejects.
 */

import { describe, expect, test } from "vitest";
import type { StartupPromptAutomation } from "../../src/core/startup-automation.ts";
import type { TrustPromptSpec } from "../../src/core/trust-prompts.ts";

const headerPattern = /trust/i;
const accept = /yes/i;

describe("trust-prompt type guards", () => {
  test("C-CLAUDE-10 C-CODEX-15 TrustPromptSpec rejects unknown ids and mismatched answerPolicy", () => {
    const validClaude = {
      agent: "claude",
      id: "plugin_trust",
      headerPattern,
      accept,
      answerPolicy: "autotrust",
    } satisfies TrustPromptSpec;
    const validHook = {
      agent: "codex",
      id: "hook_trust",
      headerPattern,
      accept,
      answerPolicy: "always",
    } satisfies TrustPromptSpec;

    const typoId = {
      agent: "claude",
      // @ts-expect-error a misspelled/unknown Claude id is not a valid trust label.
      id: "plugin_truts",
      headerPattern,
      accept,
      answerPolicy: "autotrust",
    } satisfies TrustPromptSpec;
    const alwaysOnClaude = {
      agent: "claude",
      id: "plugin_trust",
      headerPattern,
      accept,
      answerPolicy: "always",
      // @ts-expect-error only Codex hook_trust may be answerPolicy "always"; third-party prompts stay gated.
    } satisfies TrustPromptSpec;
    const alwaysOnCodexWorkspace = {
      agent: "codex",
      id: "workspace_trust",
      headerPattern,
      accept,
      answerPolicy: "always",
      // @ts-expect-error only hook_trust may be answerPolicy "always"; Codex folder trust stays gated.
    } satisfies TrustPromptSpec;

    expect(validClaude.id).toBe("plugin_trust");
    expect(validHook.answerPolicy).toBe("always");
    expect(typoId.agent).toBe("claude");
    expect(alwaysOnClaude.id).toBe("plugin_trust");
    expect(alwaysOnCodexWorkspace.id).toBe("workspace_trust");
  });

  test("C-CLAUDE-11 C-CODEX-12 StartupPromptAutomation correlates labels to their agent", () => {
    const claudeAnswered = {
      kind: "answered",
      prompt: "browser_tools",
      input: "2",
    } satisfies StartupPromptAutomation<"claude">;
    const codexAnswered = {
      kind: "answered",
      prompt: "update",
      input: "1",
    } satisfies StartupPromptAutomation<"codex">;

    const claudeWithCodexLabel = {
      kind: "answered",
      // @ts-expect-error `update` is Codex-only and cannot label a Claude automation.
      prompt: "update",
      input: "1",
    } satisfies StartupPromptAutomation<"claude">;
    const codexWithClaudeBrowser = {
      kind: "answered",
      // @ts-expect-error `browser_tools` is Claude-only and cannot label a Codex automation.
      prompt: "browser_tools",
      input: "1",
    } satisfies StartupPromptAutomation<"codex">;
    const codexWithClaudeMcp = {
      kind: "answered",
      // @ts-expect-error `mcp_trust` is a Claude-only trust id and cannot label a Codex automation.
      prompt: "mcp_trust",
      input: "1",
    } satisfies StartupPromptAutomation<"codex">;

    expect(claudeAnswered.prompt).toBe("browser_tools");
    expect(codexAnswered.prompt).toBe("update");
    expect(claudeWithCodexLabel.kind).toBe("answered");
    expect(codexWithClaudeBrowser.kind).toBe("answered");
    expect(codexWithClaudeMcp.kind).toBe("answered");
  });

  test("C-CLAUDE-14 an option_pending automation is limited to that agent's trust ids", () => {
    const validPending = {
      kind: "option_pending",
      prompt: "mcp_trust",
    } satisfies StartupPromptAutomation<"claude">;

    const claudeNonTrustPending = {
      kind: "option_pending",
      prompt: "browser_tools",
      // @ts-expect-error `browser_tools` is a non-trust prompt and can never be recognized-but-option-pending.
    } satisfies StartupPromptAutomation<"claude">;
    const codexNonTrustPending = {
      kind: "option_pending",
      prompt: "update",
      // @ts-expect-error `update` is a non-trust prompt and can never be recognized-but-option-pending.
    } satisfies StartupPromptAutomation<"codex">;

    expect(validPending.prompt).toBe("mcp_trust");
    expect(claudeNonTrustPending.kind).toBe("option_pending");
    expect(codexNonTrustPending.kind).toBe("option_pending");
  });
});
