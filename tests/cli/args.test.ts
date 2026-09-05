/**
 * CLI grammar conformance coverage.
 * Covers PRD §12A.1 and C-CLI-02/C-CLI-04/C-CLI-06.
 */

import { describe, expect, test } from "vitest";
import { parseCliArgs } from "../../src/cli/args.ts";

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
    expect(parseCliArgs(["help"])).toEqual({ command: "help" });
    expect(parseCliArgs(["config", "show"])).toEqual({ command: "config", args: ["show"] });
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
      "--stream",
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
        stream: true,
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

  test.each([
    ["--unknown"],
    ["--agent"],
    ["--trust", "--no-trust", "prompt"],
  ])("C-CLI-06 rejects malformed options: %j", (...argv) => {
    expect(() => parseCliArgs(argv)).toThrowError(/option|trust/iu);
  });
});
