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
    // so it is answered regardless of autotrust — unlike third-party trust.
    const responder = new CodexStartupPromptResponder();
    responder.handle("Hooks need review\n  1. Review hooks", (input) => writes.push(input));
    responder.handle("Hooks need review\n› 1. Review hooks\n  2. Trust all and continue", (input) =>
      writes.push(input),
    );
    responder.handle("\n  3. Continue without trusting", (input) => writes.push(input));
    expect(writes).toEqual(["2\r"]);
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
    expect(result.automations).toEqual([{ prompt: "workspace_trust", input: "1" }]);
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
