/**
 * Focused coverage for Codex startup prompt automation.
 * Covers PRD §4.4 and §5.5.
 */

import { describe, expect, test } from "vitest";
import {
  CodexStartupPromptResponder,
  codexWarningsFromText,
  findNumberedOption,
} from "../../src/codex/startup-prompts.ts";
import { createHeadlessTerminal } from "../../src/terminal/headless.ts";

describe("Codex startup prompt responder", () => {
  test("C-API-15 exposes a controllable headless terminal handle", async () => {
    const inputs: Array<string | Uint8Array> = [];
    const terminal = createHeadlessTerminal({ cols: 20, rows: 4 }, (input) => inputs.push(input));
    const bytes = new Uint8Array([0xff, 0x00]);
    expect(terminal.size).toEqual({ cols: 20, rows: 4 });
    terminal.sendInput("x");
    terminal.sendInput(bytes);
    terminal.resize({ cols: 30, rows: 5 });
    await terminal.writeOutput(new Uint8Array([65, 66]));
    await terminal.settled();
    expect(inputs).toEqual(["x", bytes]);
    expect(terminal.size).toEqual({ cols: 30, rows: 5 });
    expect(terminal.snapshot().text).toContain("AB");
    terminal.dispose();
  });

  test("C-CODEX-06 trusts hook review prompts once, even without autotrust", () => {
    const writes: string[] = [];
    // Hook trust is Elwood's OWN integration (required for the session to work),
    // so it is answered regardless of autotrust — unlike third-party trust. The
    // phrase and its answer appear in the SAME frame (as the real CLI renders).
    const responder = new CodexStartupPromptResponder();
    const frame = "Hooks need review\n› 1. Review hooks\n  2. Trust all and continue";
    responder.handle(frame, (input) => writes.push(input));
    responder.handle(frame, (input) => writes.push(input)); // repeat: answered once
    expect(writes).toEqual(["2\r"]);
  });

  test("C-CODEX-15 a stale trust phrase never auto-confirms a DIFFERENT dialog", () => {
    // The security regression: frame 1 shows the hook-trust phrase; frame 2 shows
    // an unrelated dialog with a "1. Yes". A buffer-accumulating matcher would
    // pair the stale phrase with frame 2's "Yes" and send 1. Frame-scoped
    // matching must NOT: no answer belongs to frame 2's dialog.
    const writes: string[] = [];
    const responder = new CodexStartupPromptResponder("s1", true);
    responder.handle("Hooks need review\n  1. Review hooks", (input) => writes.push(input));
    const result = responder.handle(
      "Delete stored credentials?\n› 1. Yes, continue\n  2. No",
      (input) => writes.push(input),
    );
    expect(writes).toEqual([]);
    expect(result.automations).toEqual([]);
  });

  test("C-CODEX-15 a SAME-frame foreign 'Yes' never auto-confirms hook trust", () => {
    // The sharper regression: within ONE rendered frame the hook-trust phrase is
    // visible ABOVE an unrelated dialog whose option is "1. Yes, continue". A
    // generic yes-matcher scanning the whole frame would send 1 to the WRONG
    // dialog. The foreign "?" line ends the hook-trust region, so hook trust has
    // NO option of its own in-frame: nothing is written and no automation fires.
    // The credential dialog's "Yes, continue" is never selected.
    const writes: string[] = [];
    const responder = new CodexStartupPromptResponder("s1", true);
    const result = responder.handle(
      "Hooks need review\nDelete stored credentials?\n› 1. Yes, continue\n  2. No",
      (input) => writes.push(input),
    );
    expect(writes).toEqual([]); // the foreign dialog's "Yes" is never selected
    expect(result.automations).toEqual([]);
  });

  test("C-CODEX-15 a SAME-frame foreign 'Yes' never auto-confirms DIRECTORY trust", () => {
    // Directory trust uses the generic yesOption, so region-scoping (not a
    // per-prompt pattern) is what protects it: an unrelated question below the
    // directory prompt ("Delete stored credentials?") ends the region, so its
    // "1. Yes, continue" is not the directory prompt's option. Nothing is written.
    const writes: string[] = [];
    const responder = new CodexStartupPromptResponder("s1", true);
    const result = responder.handle(
      "Do you trust the contents of this directory?\nDelete stored credentials?\n› 1. Yes, continue\n  2. No",
      (input) => writes.push(input),
    );
    expect(writes).toEqual([]);
    expect(result.automations).toEqual([]);
  });

  test("C-CODEX-15 does not trust the DIRECTORY prompt without autotrust", () => {
    const writes: string[] = [];
    const responder = new CodexStartupPromptResponder();
    const result = responder.handle(
      "Do you trust the contents of this directory?\n› 1. Yes, continue\n  2. No, quit",
      (input) => writes.push(input),
    );
    expect(writes).toEqual([]);
    expect(result.automations).toEqual([]);
  });

  test("C-CODEX-11 trusts directory prompts when autotrust is enabled", () => {
    const writes: string[] = [];
    const responder = new CodexStartupPromptResponder("s1", true);
    const result = responder.handle(
      "Do you trust the contents of this directory?\n› 1. Yes, continue\n  2. No, quit",
      (input) => writes.push(input),
    );
    expect(result.automations).toEqual([
      { kind: "answered", prompt: "workspace_trust", input: "1" },
    ]);
    expect(writes).toEqual(["1\r"]);
  });

  test("C-CODEX-12 skips recognized update prompts", () => {
    const writes: string[] = [];
    const responder = new CodexStartupPromptResponder();
    responder.handle("Update available\n  1. Update now", (input) => writes.push(input));
    responder.handle("Update available\n  1. Update now\n  2. Continue without updating", (input) =>
      writes.push(input),
    );
    expect(writes).toEqual(["2"]);
  });

  test("C-CODEX-12 skips current Codex release update prompts", () => {
    const writes: string[] = [];
    const responder = new CodexStartupPromptResponder();
    responder.handle("Update available! 0.132.0 -> 0.133.0\n\n› 1. Update now", (input) =>
      writes.push(input),
    );
    responder.handle("\n  2. Skip\n  3. Skip until next version", (input) => writes.push(input));
    expect(writes).toEqual(["2"]);
  });

  test("C-PTY-07 C-CODEX-12 skips cursor-addressed xterm-rendered update prompts", async () => {
    const writes: string[] = [];
    const responder = new CodexStartupPromptResponder();
    const terminal = createHeadlessTerminal({ cols: 90, rows: 12 }, () => {});
    await terminal.writeOutput(
      "\u001b[2;1HUpdate available! 0.132.0 -> 0.133.0" +
        "\u001b[6;1H› 1. Update now (runs `npm install -g @openai/codex`)" +
        "\u001b[7;3H2.\u001b[7;6HSkip" +
        "\u001b[8;3H3.\u001b[8;6HSkip\u001b[8;11Huntil\u001b[8;17Hnext\u001b[8;22Hversion",
    );
    expect(terminal.snapshot().text).toContain("2. Skip");
    responder.handle(terminal.snapshot().text, (input) => writes.push(input));
    terminal.dispose();
    expect(writes).toEqual(["2"]);
  });

  test("C-CODEX-12 skips concatenated Codex release update prompts", () => {
    const writes: string[] = [];
    const responder = new CodexStartupPromptResponder();
    responder.handle(
      "Update available! 0.132.0 -> 0.133.0 Release notes: url › 1. Update now  2. Skip  3. Skip until next version",
      (input) => writes.push(input),
    );
    expect(writes).toEqual(["2"]);
  });

  test("numbered option matching ignores unknown prompts", () => {
    expect(findNumberedOption("1. Review hooks", /Trust all/)).toBeNull();
    expect(findNumberedOption("> 3) Skip for now", /skip/i)).toBe("3");
    expect(findNumberedOption("› 1. Update now  2. Skip  3. Later", /skip/i)).toBe("2");
  });

  test("C-CODEX-09 parses typed MCP startup warnings", () => {
    const warnings = codexWarningsFromText(
      "The linear MCP server is not logged in. Run `codex mcp login linear`.\nMCP startup incomplete (failed: linear, github)",
      "s1",
    );
    expect(warnings[0]).toMatchObject({
      code: "mcp_server_not_logged_in",
      mcpServerName: "linear",
      recoveryCommand: "codex mcp login linear",
    });
    expect(warnings[1]).toMatchObject({
      code: "mcp_startup_incomplete",
      failedServers: ["linear", "github"],
    });
  });
});
