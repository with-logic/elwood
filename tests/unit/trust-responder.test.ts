/**
 * Focused coverage for the allowlisted trust-prompt automation.
 * Covers PRD §5.1, §5.5, C-CLAUDE-10, C-CODEX-11, C-CLAUDE-14, and C-CODEX-15.
 */

import { describe, expect, test } from "vitest";
import { TrustPromptResponder, trustPromptVisible } from "../../src/core/trust-responder.ts";

describe("allowlisted trust prompt automation", () => {
  test("C-API-18 stays disabled unless callers opt in", () => {
    const writes: string[] = [];
    const responder = new TrustPromptResponder("claude");
    const result = responder.handle("Quick safety check: trust this folder?", (input) =>
      writes.push(input),
    );
    expect(result).toBeUndefined();
    expect(writes).toEqual([]);
  });

  test("C-CLAUDE-10 answers Claude workspace trust prompts once", () => {
    const writes: string[] = [];
    const responder = new TrustPromptResponder("claude", true);
    expect(
      responder.handle("Do you trust this folder?\n1. Yes", (input) => writes.push(input)),
    ).toEqual({ kind: "answered", automation: { prompt: "workspace_trust", input: "1" } });
    expect(
      responder.handle("Do you trust this folder?", (input) => writes.push(input)),
    ).toBeUndefined();
    expect(writes).toEqual(["1\r"]);
  });

  test("C-CLAUDE-10 answers the REAL claude 2.1.206 folder-trust frame, header WRAPPED", () => {
    // Captured from claude 2.1.206 (C-E2E-09). The header question wraps across
    // physical rows on a narrow terminal, and the trust phrase lives in the header
    // AND the option — recognition must match the joined wrapped header (not a
    // single line), and answer the affirmative. Regression: header-anchored
    // line-by-line matching silently missed the wrapped header, wedging autotrust.
    const writes: string[] = [];
    const frame = [
      "Quick safety check: Is this a project you created or one you",
      "trust? (Like your own code, a well-known open source project). If not,",
      "take a moment to review what's in this folder first.",
      "Claude Code'll be able to read, edit, and execute files here.",
      "Security guide",
      "❯ 1. Yes, I trust this folder",
      "  2. No, exit",
      "Enter to confirm · Esc to cancel",
    ].join("\n");
    expect(new TrustPromptResponder("claude", true).handle(frame, (i) => writes.push(i))).toEqual({
      kind: "answered",
      automation: { prompt: "workspace_trust", input: "1" },
    });
    expect(writes).toEqual(["1\r"]);
  });

  test("C-CLAUDE-14 answers the allowlisted skill/plugin/MCP trust prompts", () => {
    for (const [screen, id, option] of [
      ["Load this skill?\n1. Yes, trust it", "skill_trust", "1"],
      ["Trust the plugin?\n1. Yes, continue", "plugin_trust", "1"],
      // Real claude 2.1.205 MCP prompt: the affirmative option is "Use this MCP
      // server" — no yes/trust/continue word — so it needs the per-prompt accept.
      [
        "New MCP server found in this project\n1. Use this MCP server\n2. Use this and all future MCP servers in this project\n3. No",
        "mcp_trust",
        "1",
      ],
    ] as const) {
      const writes: string[] = [];
      const responder = new TrustPromptResponder("claude", true);
      expect(responder.handle(screen, (input) => writes.push(input))).toEqual({
        kind: "answered",
        automation: { prompt: id, input: option },
      });
      expect(writes).toEqual([`${option}\r`]);
    }
  });

  test("C-CLAUDE-14 does not answer an off-allowlist first-run prompt", () => {
    const writes: string[] = [];
    const responder = new TrustPromptResponder("claude", true);
    // A generic confirmation that is NOT an allowlisted trust prompt: ignored,
    // so a future CLI security gate is never blanket-bypassed.
    expect(
      responder.handle("Enable telemetry for this session?\n1. Yes", (input) => writes.push(input)),
    ).toBeUndefined();
    expect(writes).toEqual([]);
  });

  test("C-CODEX-11 C-CODEX-15 detects Codex directory and hook trust prompts", () => {
    expect(trustPromptVisible("Do you trust the contents of this directory?", "codex")).toBe(true);
    // Hook trust is now an allowlisted trust prompt, so it is recognized too.
    expect(trustPromptVisible("Hooks need review", "codex")).toBe(true);
    expect(trustPromptVisible("Some unrelated banner", "codex")).toBe(false);
  });

  test("C-CLAUDE-14 recognized-but-unanswerable prompt is flagged, not silently skipped", () => {
    const writes: string[] = [];
    const responder = new TrustPromptResponder("claude", true);
    // The prompt is recognized but its verified affirmative option is absent, so
    // the responder writes nothing AND surfaces `unanswerable` (a wedge signal),
    // once. A wrong "No, cancel" option is never selected.
    expect(
      responder.handle("Do you trust this folder?\n1. No, cancel", (input) => writes.push(input)),
    ).toEqual({ kind: "unanswerable", prompt: "workspace_trust" });
    // Settled once: a second frame does not re-flag.
    expect(
      responder.handle("Do you trust this folder?\n1. No, cancel", (input) => writes.push(input)),
    ).toBeUndefined();
    expect(writes).toEqual([]);
  });

  test("C-CLAUDE-14 a prompt's option region stops at a DIFFERENT prompt's header", () => {
    const writes: string[] = [];
    const responder = new TrustPromptResponder("claude", true);
    // Folder-trust is visible with NO option of its own; a skill-trust dialog
    // below has "1. Yes". The region for folder-trust must stop at the skill
    // header, so folder-trust does NOT steal the skill dialog's Yes. Folder-trust
    // is thus unanswerable; the skill prompt (later in the loop) is answered.
    const frame = "Do you trust this folder?\nLoad this skill?\n1. Yes, trust it";
    const result = responder.handle(frame, (input) => writes.push(input));
    // workspace_trust's region ends at the skill header, so it has NO option of
    // its own and does NOT steal the skill dialog's Yes. The skill prompt, from
    // ITS own region, is correctly answered "1" — each prompt owns its options.
    expect(result).toEqual({ kind: "answered", automation: { prompt: "skill_trust", input: "1" } });
    expect(writes).toEqual(["1\r"]); // the "1" belongs to skill_trust, not folder trust
  });

  test("C-CLAUDE-14 a trust dialog's region spans blank/descriptive lines to its options", () => {
    const writes: string[] = [];
    const responder = new TrustPromptResponder("claude", true);
    // A real trust dialog renders header → blank/descriptive lines → options as
    // ONE dialog (claude 2.1.206, C-E2E-09). The region MUST span the blanks to
    // reach the affirmative — the prior line-boundary rule wedged the agent here.
    const frame =
      "Do you trust this folder?\n\nClaude Code can read/edit here.\n\n1. Yes, proceed\n2. No";
    expect(responder.handle(frame, (input) => writes.push(input))).toEqual({
      kind: "answered",
      automation: { prompt: "workspace_trust", input: "1" },
    });
    expect(writes).toEqual(["1\r"]);
  });

  test("C-CLAUDE-14 a mid-render header without options is retried, not wedged unanswerable", () => {
    const writes: string[] = [];
    const responder = new TrustPromptResponder("claude", true);
    // Frame 1: header drawn, options not yet rendered. It must NOT settle as
    // unanswerable (that would wedge the prompt before its option appears).
    expect(
      responder.handle("Do you trust this folder?", (input) => writes.push(input)),
    ).toBeUndefined();
    // Frame 2: the option has now rendered — the prompt answers normally.
    expect(
      responder.handle("Do you trust this folder?\n1. Yes, proceed", (input) => writes.push(input)),
    ).toEqual({ kind: "answered", automation: { prompt: "workspace_trust", input: "1" } });
    expect(writes).toEqual(["1\r"]);
  });
});
