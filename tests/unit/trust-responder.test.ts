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
    // The FIRST spec in allowlist order is workspace_trust: its region excludes
    // the skill option, so it is surfaced as unanswerable (never answered wrong).
    expect(result).toEqual({ kind: "unanswerable", prompt: "workspace_trust" });
    expect(writes).toEqual([]); // the skill dialog's Yes was NOT written for folder trust
  });

  test("C-CLAUDE-14 a blank line after an option ends the prompt's region", () => {
    const writes: string[] = [];
    const responder = new TrustPromptResponder("claude", true);
    // Folder-trust header, its own declined-only option, then a blank line, then
    // an unrelated dialog's Yes. The blank line (after an option was seen) ends
    // the region, so the trailing foreign Yes is not considered.
    const frame = "Do you trust this folder?\n1. No, cancel\n\nSomething else\n1. Yes, do it";
    expect(responder.handle(frame, (input) => writes.push(input))).toEqual({
      kind: "unanswerable",
      prompt: "workspace_trust",
    });
    expect(writes).toEqual([]);
  });
});
