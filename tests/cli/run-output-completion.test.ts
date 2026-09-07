/**
 * Human progress completion variants (PRD §12A.3, C-CLI-10).
 */

import { describe, expect, test } from "vitest";
import type { CliError, CliResult } from "../../src/cli/output/types.ts";
import { RunOutput } from "../../src/cli/run-output.ts";
import { AsyncOutputSink } from "../../src/cli/stream.ts";
import type { EffectiveRunRequest } from "../../src/cli/types.ts";
import { MemoryWriter } from "./run-fakes.ts";

function output() {
  const request: EffectiveRunRequest = {
    agent: "codex",
    output: "text",
    outputExplicit: false,
    trust: true,
    stateDir: "/state",
    verbose: true,
    stream: false,
    cwd: "/work",
    images: [],
    prompt: "go",
    keep: false,
    ephemeral: false,
    sandbox: "workspace-write",
    approvalPolicy: "never",
  };
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();
  return {
    stderr,
    output: new RunOutput(
      request,
      new AsyncOutputSink(stdout),
      new AsyncOutputSink(stderr),
      { consumerClosed: () => {}, failed: () => {} },
      () => 0,
    ),
  };
}

function result(cleanup: CliResult["cleanup"]): CliResult {
  return {
    schemaVersion: 1,
    type: "result",
    agent: "codex",
    response: "ok",
    sessionId: null,
    durationMs: 1,
    cleanup,
  };
}

describe("RunOutput completion progress", () => {
  test("distinguishes preserved, failed, and unnecessary cleanup", async () => {
    const preserved = output();
    await preserved.output.finish(() => result({ action: "preserve", status: "succeeded" }));
    expect(preserved.stderr.value).toContain("Completed; session preserved");

    const failed = output();
    const error: CliError = {
      ...result({ action: "teardown", status: "failed", error: "denied" }),
      type: "error",
      error: { code: "runtime_error", message: "Failed." },
    };
    await failed.output.finish(() => error);
    expect(failed.stderr.value).toContain("Failed (runtime_error); cleanup failed");

    const none = output();
    await none.output.finish(() => result({ action: "none", status: "succeeded" }));
    expect(none.stderr.value).toContain("Completed; no session cleanup needed");
  });
});
