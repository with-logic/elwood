/** Startup personas fail explicitly before an over-budget session starts (C-API-21/58). */
import { afterEach, expect, test, vi } from "vitest";
import * as claudePreflight from "../../src/claude/preflight.ts";
import * as codexPreflight from "../../src/codex/preflight.ts";
import { ControlQueue } from "../../src/core/control-queue/index.ts";
import { ElwoodError } from "../../src/core/errors.ts";
import { startClaude, startCodex } from "../../src/index.ts";
import * as claude from "../claude/helpers.ts";
import * as codex from "../codex/helpers.ts";

afterEach(() => {
  vi.restoreAllMocks();
  claude.resetFakes();
  codex.resetFakes();
});

test.each([
  "claude",
  "codex",
] as const)("C-API-58 %s rejects oversized persona before spawn", async (agent) => {
  const helper = agent === "claude" ? claude : codex;
  helper.installFakes();
  const preflight =
    agent === "claude"
      ? vi.spyOn(claudePreflight, "preflightClaude")
      : vi.spyOn(codexPreflight, "preflightCodex");
  let queuedError: string | undefined;
  const send = ControlQueue.prototype.send;
  vi.spyOn(ControlQueue.prototype, "send").mockImplementation(function (
    this: ControlQueue,
    ...args
  ) {
    const promise = send.apply(this, args);
    void promise.catch((error: unknown) => {
      queuedError = error instanceof ElwoodError ? error.code : "other";
    });
    return promise;
  });
  let session:
    | Awaited<ReturnType<typeof startClaude>>
    | Awaited<ReturnType<typeof startCodex>>
    | undefined;
  let result = "started";
  try {
    try {
      session = await (agent === "claude" ? startClaude : startCodex)({
        cwd: helper.tempDir(),
        persona: `${"é".repeat(4 * 1024 * 1024)}x`,
      });
    } catch (error) {
      result = error instanceof ElwoodError ? error.code : "other";
    }
    await Promise.resolve();
    expect({ result, queuedError, spawned: helper.ptys.length }).toEqual({
      result: "input_queue_full",
      queuedError: undefined,
      spawned: 0,
    });
    expect(preflight).not.toHaveBeenCalled();
  } finally {
    await session?.teardown();
  }
});
