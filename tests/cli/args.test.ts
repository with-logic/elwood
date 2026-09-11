/**
 * CLI grammar conformance coverage.
 * Covers PRD §12A.1 and C-CLI-02/C-CLI-04/C-CLI-06.
 */

import { describe, expect, test } from "vitest";
import { argumentErrorMessage } from "../../src/cli/args/errors.ts";
import { parseCliArgs } from "../../src/cli/args/index.ts";

describe("CLI argument grammar", () => {
  test.each([
    { argv: ["hello", "world"], promptWords: ["hello", "world"] },
    { argv: ["run", "hello", "world"], promptWords: ["hello", "world"] },
    { argv: ["--", "run", "hello"], promptWords: ["run", "hello"] },
    { argv: ["hello", "config"], promptWords: ["hello", "config"] },
  ])("C-CLI-02 parses $argv as a run", ({ argv, promptWords }) => {
    expect(parseCliArgs(argv)).toMatchObject({ command: "run", promptWords });
  });

  test("C-CLI-02 reserves command words only in first position", () => {
    expect(parseCliArgs([])).toEqual({ command: "help" });
    expect(parseCliArgs(["help"])).toEqual({ command: "help" });
    expect(parseCliArgs(["config", "show"])).toEqual({ command: "config", args: ["show"] });
    expect(parseCliArgs(["run"])).toMatchObject({ command: "run", promptWords: [] });
  });

  test("C-CLI-04 retains repeated images, equals options, and explicitness", () => {
    const parsed = parseCliArgs([
      "run",
      "-C",
      "work",
      "--agent=claude",
      "--image=a.png",
      "--image",
      "b.png",
      "prompt",
    ]);
    expect(parsed).toMatchObject({
      command: "run",
      flags: { agent: "claude", cwd: "work", images: ["a.png", "b.png"] },
      promptWords: ["prompt"],
    });
    if (parsed.command !== "run") throw new Error("expected run");
    expect([...parsed.explicit]).toEqual(["cwd", "agent", "images"]);
  });

  test("C-CLI-06 parses every run flag and metadata switch", () => {
    const parsed = parseCliArgs([
      "--output",
      "text",
      "--timeout",
      "5s",
      "--trust",
      "--state-dir",
      "state",
      "--verbose",
      "--no-stream",
      "--debug",
      "--no-defaults",
      "--head",
      "--persona",
      "careful",
      "--model",
      "m",
      "--reasoning-effort",
      "high",
      "--claude-permission-mode",
      "plan",
      "--codex-sandbox",
      "read-only",
      "--codex-approval-policy",
      "on-request",
      "--keep",
      "--resume",
      "s1",
      "--ephemeral",
      "go",
    ]);
    expect(parsed).toMatchObject({
      command: "run",
      flags: {
        output: "text",
        timeout: "5s",
        trust: true,
        stateDir: "state",
        verbose: true,
        stream: false,
        debug: true,
        ignoreDefaults: true,
        head: true,
        persona: "careful",
        model: "m",
        reasoningEffort: "high",
        claudePermissionMode: "plan",
        codexSandbox: "read-only",
        codexApprovalPolicy: "on-request",
        keep: true,
        resume: "s1",
        ephemeral: true,
      },
    });
    expect(parseCliArgs(["--help"])).toEqual({ command: "help" });
    expect(parseCliArgs(["--version"])).toEqual({ command: "version" });
    expect(parseCliArgs(["prompt"])).toMatchObject({ flags: { images: [] } });
  });

  test("C-CLI-14 negative flags reverse inherited booleans", () => {
    expect(parseCliArgs(["--no-stream", "--no-verbose", "prompt"])).toMatchObject({
      command: "run",
      flags: { stream: false, verbose: false },
    });
  });

  test("C-CLI-20 unknown options use user-facing suggestions", () => {
    expect(() => parseCliArgs(["--verbsoe"])).toThrowError(
      "Unknown option '--verbsoe'. Did you mean '--verbose'?",
    );
    expect(() => parseCliArgs(["--no-verbsoe"])).toThrowError(
      "Unknown option '--no-verbsoe'. Did you mean '--no-verbose'?",
    );
    expect(() => parseCliArgs(["--zzzzzz"])).toThrowError("Unknown option '--zzzzzz'.");
  });

  test("C-CLI-20 parser fallbacks stay concise for non-errors and short options", () => {
    expect(argumentErrorMessage("private")).toBe("Could not parse command-line arguments.");
    expect(
      argumentErrorMessage(
        Object.assign(new Error("Unknown option '-z'"), {
          code: "ERR_PARSE_ARGS_UNKNOWN_OPTION",
        }),
      ),
    ).toBe("Unknown option '-z'.");
  });

  test.each([
    ["--unknown"],
    ["--agent"],
    ["--trust", "--no-trust", "prompt"],
    ["--stream", "--no-stream", "prompt"],
    ["--verbose", "--no-verbose", "prompt"],
  ])("C-CLI-06 rejects malformed options: %j", (...argv) => {
    expect(() => parseCliArgs(argv)).toThrowError(/option|trust|combined/iu);
  });
});
