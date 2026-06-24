/**
 * Focused coverage for workspace trust prompt automation.
 * Covers PRD §5.1, §5.5, C-CLAUDE-10, and C-CODEX-11.
 */

import { describe, expect, test } from "vitest";
import {
  WorkspaceTrustResponder,
  workspaceTrustPromptVisible,
} from "../../src/core/workspace-trust.ts";

describe("workspace trust prompt automation", () => {
  test("C-API-18 stays disabled unless callers opt in", () => {
    const writes: string[] = [];
    const responder = new WorkspaceTrustResponder("claude");
    const result = responder.handle("Quick safety check: trust this folder?", (input) =>
      writes.push(input),
    );
    expect(result).toBeUndefined();
    expect(writes).toEqual([]);
  });

  test("C-CLAUDE-10 answers Claude workspace trust prompts once", () => {
    const writes: string[] = [];
    const responder = new WorkspaceTrustResponder("claude", true);
    expect(
      responder.handle("Do you trust this folder?\n1. Yes", (input) => writes.push(input)),
    ).toEqual({
      prompt: "workspace_trust",
      input: "1",
    });
    expect(
      responder.handle("Do you trust this folder?", (input) => writes.push(input)),
    ).toBeUndefined();
    expect(writes).toEqual(["1\r"]);
  });

  test("C-CODEX-11 detects Codex directory trust prompts", () => {
    expect(
      workspaceTrustPromptVisible("Do you trust the contents of this directory?", "codex"),
    ).toBe(true);
    expect(workspaceTrustPromptVisible("Hooks need review", "codex")).toBe(false);
  });
});
