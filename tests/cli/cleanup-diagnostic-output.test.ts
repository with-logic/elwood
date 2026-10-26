/**
 * Where the CLI's cleanup diagnostic surfaces (PRD §12A.2-§12A.3, §12A.10, C-CLI-09,
 * C-CLI-26): `run`'s text, JSON, and JSONL output, single-agent and combined `models`,
 * and text mode's own line for a cleanup failure behind a different primary failure.
 */

import { describe, expect, test } from "vitest";
import { main } from "../../src/cli/main.ts";
import { executeModels } from "../../src/cli/models/index.ts";
import { executeRun } from "../../src/cli/run/index.ts";
import { AsyncOutputSink } from "../../src/cli/stream.ts";
import type { EffectiveRunRequest } from "../../src/cli/types.ts";
import { elwoodError } from "../../src/core/errors.ts";
import { effectiveRequest } from "./main-fakes.ts";
import { modelsHarness } from "./models-fakes.ts";
import { FakeCliSession, FakeClock, FakeSignals, MemoryWriter } from "./run-fakes.ts";

const typedCleanupFailure = () =>
  elwoodError("teardown_failed", "Could not fully tear down.", {
    causes: ["private reap detail"],
    failures: [
      {
        message: "private reap detail",
        code: "termination_failed",
        details: { errno: "EPERM", path: "/private/path" },
      },
    ],
  });
const diagnostic = "Cleanup failed (termination_failed EPERM).";

function execute(
  run: typeof executeRun | typeof executeModels,
  session: FakeCliSession,
  overrides: Partial<EffectiveRunRequest> = {},
) {
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();
  const status = run(
    effectiveRequest({ keep: true, ...overrides }),
    session,
    { stdout: new AsyncOutputSink(stdout), stderr: new AsyncOutputSink(stderr) },
    { signals: new FakeSignals() },
  );
  return { status, stdout, stderr };
}

describe("C-CLI-09 run", () => {
  test("C-CLI-09 cleanup failure keeps response and changes success to failure", async () => {
    const session = new FakeCliSession();
    session.cleanupError = new Error("private cleanup detail");
    const h = execute(executeRun, session);
    expect(await h.status).toBe(1);
    expect(h.stdout.value).toBe("ok\n");
    expect(h.stderr.value).toBe("elwood: Cleanup failed.\n");
  });

  test("C-CLI-09 a typed cleanup failure is named by its codes, never its messages", async () => {
    const session = new FakeCliSession();
    session.cleanupError = typedCleanupFailure();
    const h = execute(executeRun, session);
    expect(await h.status).toBe(1);
    expect(h.stdout.value).toBe("ok\n");
    expect(h.stderr.value).toBe(`elwood: ${diagnostic}\n`);
  });

  test.each([
    "json",
    "jsonl",
  ] as const)("C-CLI-09 %s output carries the typed cleanup diagnostic", async (output) => {
    const session = new FakeCliSession();
    session.cleanupError = typedCleanupFailure();
    const h = execute(executeRun, session, { output });
    expect(await h.status).toBe(1);
    const lines = h.stdout.value.trim().split("\n");
    expect(JSON.parse(lines[lines.length - 1]!)).toMatchObject({
      type: "error",
      response: "ok",
      cleanup: { action: "preserve", status: "failed", error: diagnostic },
      error: { code: "cleanup_failed", message: diagnostic },
    });
    expect(h.stdout.value).not.toContain("private");
  });

  test("C-CLI-09 text mode gives a cleanup failure behind an agent failure its own line", async () => {
    const session = new FakeCliSession();
    session.streamWork = () => Promise.reject(elwoodError("turn_failed", "The turn failed."));
    session.cleanupError = typedCleanupFailure();
    const h = execute(executeRun, session);
    expect(await h.status).toBe(1);
    expect(h.stderr.value).toBe(`elwood: The turn failed.\nelwood: ${diagnostic}\n`);
  });
});

describe("C-CLI-26 models", () => {
  test("C-CLI-26 text mode gives a cleanup failure behind a listing failure its own line", async () => {
    const session = new FakeCliSession();
    session.underlying.listModels = () => Promise.reject(new Error("picker failed"));
    session.cleanupError = typedCleanupFailure();
    const h = execute(executeModels, session);
    expect(await h.status).toBe(1);
    expect(h.stdout.value).toBe("");
    expect(h.stderr.value).toBe(`elwood: Agent execution failed.\nelwood: ${diagnostic}\n`);
  });

  test.each([
    "text",
    "json",
  ] as const)("C-CLI-26 a combined %s listing keeps a probe's typed cleanup failure", async (output) => {
    const h = modelsHarness();
    const clock = new FakeClock();
    const dependencies = {
      ...h.dependencies,
      now: clock.now,
      prepare: async (...input: Parameters<typeof h.dependencies.prepare>) => {
        const prepared = await h.dependencies.prepare(...input);
        h.sessions[0]!.cleanupError = typedCleanupFailure();
        clock.value = 100; // Preparation exhausts the budget, so the probe is torn down.
        return prepared;
      },
    };
    const args = ["models", "--timeout", "100ms", "--output", output];
    expect(await main(args, h.context, dependencies)).toBe(124);
    if (output === "text") {
      expect(h.stderr.value).toBe(`elwood: claude: Timed out.\nelwood: claude: ${diagnostic}\n`);
      return;
    }
    expect(JSON.parse(h.stdout.value).errors).toEqual([
      expect.objectContaining({
        error: { code: "timeout", message: "Timed out." },
        cleanup: { action: "teardown", status: "failed", error: diagnostic },
      }),
    ]);
  });
});
