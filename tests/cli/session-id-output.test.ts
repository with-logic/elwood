/** Opt-in retained-session diagnostics (PRD §12A.3, C-CLI-27). */
import { describe, expect, test } from "vitest";
import { parseCliArgs } from "../../src/cli/args/index.ts";
import { resolveRunSettings } from "../../src/cli/request/index.ts";
import { RunOutput } from "../../src/cli/run/output.ts";
import { AsyncOutputSink } from "../../src/cli/stream.ts";
import { effectiveRequest } from "./main-fakes.ts";
import { MemoryWriter } from "./run-fakes.ts";

describe("C-CLI-27 session identity output", () => {
  test.each([false, true])("retention is quiet unless requested: %s", async (showSessionId) => {
    const parsed = parseCliArgs([
      "--agent",
      "codex",
      ...(showSessionId ? ["--show-session-id"] : []),
      "go",
    ]);
    if (parsed.command !== "run") throw new Error("expected run");
    const draft = await resolveRunSettings(parsed, {
      env: {},
      invocationCwd: "/work",
      homeDir: "/nonexistent",
    });
    expect(draft.keep).toBe(true);
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    const output = new RunOutput(
      effectiveRequest({ keep: draft.keep, showSessionId: draft.showSessionId === true }),
      new AsyncOutputSink(stdout),
      new AsyncOutputSink(stderr),
      {
        consumerClosed: () => {},
        failed: (error) => {
          throw error;
        },
      },
      () => 0,
    );
    await output.finish(() => ({
      schemaVersion: 1,
      type: "result",
      agent: "codex",
      response: "answer",
      sessionId: "s1",
      durationMs: 1,
      cleanup: { action: "preserve", status: "succeeded" },
    }));
    expect(stdout.value).toBe("answer\n");
    expect(stderr.value).toBe(showSessionId ? "elwood: session s1\n" : "");
  });
  test.each(["sessions", "models", "interactive"])("rejects the flag for %s", (command) => {
    expect(() => parseCliArgs([command, "--show-session-id"])).toThrow(/cannot be combined/);
  });
  test("accepts the flag on resume", () => {
    expect(parseCliArgs(["resume", "s1", "--show-session-id", "go"])).toMatchObject({
      flags: { showSessionId: true, resume: "s1" },
    });
  });
});
