/**
 * Parse-time grammar for the resume, interactive, sessions, and models commands.
 * Covers PRD §12A.7-§12A.10 and C-CLI-23 through C-CLI-26.
 */

import { describe, expect, test } from "vitest";
import { parseCliArgs } from "../../src/cli/args/index.ts";
import type { ParsedRunCommand } from "../../src/cli/types.ts";

function run(argv: readonly string[]): ParsedRunCommand {
  const parsed = parseCliArgs(argv);
  if (parsed.command !== "run") throw new Error(`expected run, got ${parsed.command}`);
  return parsed;
}

describe("resume subcommand", () => {
  test("C-CLI-23 rewrites resume <id> [prompt...] onto the run path", () => {
    const parsed = run(["resume", "abc", "--output", "json", "what", "code?"]);
    expect(parsed.flags).toMatchObject({ resume: "abc", output: "json", images: [] });
    expect(parsed.promptWords).toEqual(["what", "code?"]);
    expect(parsed.explicit.has("resume")).toBe(true);
    expect(parsed.explicit.has("output")).toBe(true);
  });

  test("C-CLI-23 accepts an id with no prompt words so piped stdin can supply the prompt", () => {
    const parsed = run(["resume", "abc"]);
    expect(parsed.flags.resume).toBe("abc");
    expect(parsed.promptWords).toEqual([]);
  });

  test("C-CLI-23 requires an id and rejects a second --resume", () => {
    expect(() => parseCliArgs(["resume"])).toThrow("resume requires a session id");
    expect(() => parseCliArgs(["resume", "--output", "json"])).toThrow(
      "resume requires a session id",
    );
    expect(() => parseCliArgs(["resume", "abc", "--resume", "def", "go"])).toThrow(
      "resume <id> cannot be combined with --resume",
    );
  });

  test.each([
    ["--help", "help"],
    ["-V", "version"],
  ])("C-CLI-23 %s passes through as %s", (flag, command) => {
    expect(parseCliArgs(["resume", flag])).toEqual({ command });
    expect(parseCliArgs(["interactive", flag])).toEqual({ command });
    expect(parseCliArgs(["sessions", flag])).toEqual({ command });
    expect(parseCliArgs(["models", flag])).toEqual({ command });
  });
});

describe("interactive command", () => {
  test("C-CLI-25 parses a fresh launch with run options and no id", () => {
    const parsed = parseCliArgs(["interactive", "--agent", "claude", "-C", "work"]);
    expect(parsed).toMatchObject({
      command: "interactive",
      run: { flags: { agent: "claude", cwd: "work" }, promptWords: [] },
    });
    expect("id" in parsed).toBe(false);
  });

  test("C-CLI-25 carries the id as the run's resume flag", () => {
    const parsed = parseCliArgs(["interactive", "abc", "--model", "opus"]);
    expect(parsed).toMatchObject({
      command: "interactive",
      id: "abc",
      run: { flags: { resume: "abc", model: "opus" }, promptWords: [] },
    });
    if (parsed.command !== "interactive") throw new Error("expected interactive");
    expect(parsed.run.explicit.has("resume")).toBe(true);
  });

  test.each([
    [["--stream"], "--stream cannot be combined with interactive."],
    [["--no-stream"], "--no-stream cannot be combined with interactive."],
    [["--verbose"], "--verbose cannot be combined with interactive."],
    [["--no-verbose"], "--no-verbose cannot be combined with interactive."],
    [["--debug"], "--debug cannot be combined with interactive."],
    [["--head"], "--head cannot be combined with interactive."],
    [["--timeout", "5s"], "--timeout cannot be combined with interactive."],
    [["--persona", "p"], "--persona cannot be combined with interactive."],
    [["--image", "a.png"], "--image cannot be combined with interactive."],
    [["--keep"], "--keep cannot be combined with interactive."],
    [["--ephemeral"], "--ephemeral cannot be combined with interactive."],
    [["--resume", "x"], "--resume cannot be combined with interactive."],
    [["--debug", "--head"], "--debug and --head cannot be combined with interactive."],
    [["--output", "json"], "--output json cannot be combined with interactive."],
    [["--output=jsonl"], "--output jsonl cannot be combined with interactive."],
    [["a", "b"], "interactive accepts at most one session id and no prompt."],
  ])("C-CLI-25 rejects %j", (args, message) => {
    expect(() => parseCliArgs(["interactive", ...args])).toThrow(message);
  });

  test("C-CLI-25 keeps text output and trust flags", () => {
    expect(parseCliArgs(["interactive", "--output", "text", "--no-trust"])).toMatchObject({
      command: "interactive",
      run: { flags: { output: "text", trust: false } },
    });
  });
});

describe("sessions command", () => {
  test("C-CLI-24 accepts state-dir, output, and no-defaults only", () => {
    const parsed = parseCliArgs(["sessions", "--state-dir", "s", "--output=json", "--no-defaults"]);
    expect(parsed).toMatchObject({
      command: "sessions",
      run: { flags: { stateDir: "s", output: "json", ignoreDefaults: true } },
    });
  });

  test.each([
    [["--agent", "claude"], "--agent cannot be combined with sessions."],
    [["--no-trust"], "--no-trust cannot be combined with sessions."],
    [["--trust"], "--trust cannot be combined with sessions."],
    [["--timeout", "1s", "--keep"], "--timeout and --keep cannot be combined with sessions."],
    [["list"], "sessions accepts options, not a prompt."],
  ])("C-CLI-24 rejects %j", (args, message) => {
    expect(() => parseCliArgs(["sessions", ...args])).toThrow(message);
  });
});

describe("models command", () => {
  test("C-CLI-26 accepts launch-relevant run options", () => {
    const parsed = parseCliArgs([
      "models",
      "--agent",
      "claude",
      "--model",
      "opus",
      "--reasoning-effort",
      "high",
      "--timeout",
      "1m",
      "--state-dir",
      "s",
      "--no-trust",
      "-C",
      "work",
      "--output",
      "json",
    ]);
    expect(parsed).toMatchObject({
      command: "models",
      run: {
        flags: {
          agent: "claude",
          model: "opus",
          reasoningEffort: "high",
          timeout: "1m",
          stateDir: "s",
          trust: false,
          cwd: "work",
          output: "json",
        },
        promptWords: [],
      },
    });
  });

  test.each([
    [["--stream"], "--stream cannot be combined with models."],
    [["--head"], "--head cannot be combined with models."],
    [["--persona", "p"], "--persona cannot be combined with models."],
    [["--image", "a.png"], "--image cannot be combined with models."],
    [["--keep"], "--keep cannot be combined with models."],
    [["--resume", "x"], "--resume cannot be combined with models."],
    [["--ephemeral"], "--ephemeral cannot be combined with models."],
    [["list"], "models accepts options, not a prompt."],
  ])("C-CLI-26 rejects %j", (args, message) => {
    expect(() => parseCliArgs(["models", ...args])).toThrow(message);
  });
});
