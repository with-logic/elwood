/**
 * Diagnostic routing and terminal-safety tests for headless CLI output (PRD §12A.3).
 */

import { describe, expect, test } from "vitest";
import { formatDiagnosticValue } from "../../src/cli/output/sanitize.ts";
import type { CliError, CliResult } from "../../src/cli/output/types.ts";
import { RunOutput } from "../../src/cli/run/output.ts";
import { AsyncOutputSink } from "../../src/cli/stream.ts";
import type { EffectiveRunRequest } from "../../src/cli/types.ts";
import type { ElwoodWarningEvent } from "../../src/core/types.ts";
import { effectiveRequest as request } from "./main-fakes.ts";
import { MemoryWriter } from "./run-fakes.ts";

const result = (): CliResult => ({
  schemaVersion: 1,
  type: "result",
  agent: "codex",
  response: "ok",
  sessionId: null,
  durationMs: 1,
  cleanup: { action: "teardown", status: "succeeded" },
});

const warning = (message = "version warning"): ElwoodWarningEvent => ({
  elwoodSessionId: "s1",
  agent: "codex",
  source: "lifecycle",
  code: "version_unparseable",
  severity: "warning",
  message,
  raw: "raw",
});

function harness(effective: EffectiveRunRequest) {
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();
  const output = new RunOutput(
    effective,
    new AsyncOutputSink(stdout),
    new AsyncOutputSink(stderr),
    { consumerClosed: () => {}, failed: () => {} },
    () => 0,
  );
  return { output, stdout, stderr };
}

describe("RunOutput diagnostic integrity", () => {
  test("C-CLI-10 JSONL warnings stay off stderr under verbose and debug", async () => {
    for (const flags of [{ verbose: true }, { debug: true }] as const) {
      const h = harness(request({ output: "jsonl", ...flags }));
      h.output.warning(warning());
      await h.output.finish(result);
      const records = h.stdout.value
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(records.map((record) => record.type)).toEqual(["warning", "result"]);
      expect(h.stderr.value).toContain("Completed; session removed");
      expect(h.stderr.value).not.toContain("version warning");
    }
  });

  test("C-CLI-10 warnings accepted before finish are rendered and later warnings are ignored", async () => {
    const h = harness(request({ verbose: true }));
    h.output.warning(warning("during cleanup"));
    await h.output.finish(result);
    h.output.warning(warning("after finish"));
    await h.output.flush();
    expect(h.stderr.value).toBe(
      "[0.0s] Warning version_unparseable: during cleanup\n[0.0s] Completed; session removed\n",
    );
  });

  test("C-CLI-12 dynamic diagnostics are sanitized and escaped onto one line", async () => {
    expect(formatDiagnosticValue("plain\nfield\tvalue")).toBe("plain\\nfield\\tvalue");
    const cwd = "/work/\u001b[31mred\u001b[0m\nforged\tname\\tail";
    const headed = harness(request({ cwd, verbose: true }));
    headed.output.starting();
    await headed.output.finish(result);
    expect(headed.stderr.value).toContain("Starting Codex in /work/red\\nforged\\tname\\\\tail\n");
    expect(headed.stderr.value).not.toContain("\u001b");

    const failed = harness(request());
    const terminal: CliError = {
      ...result(),
      type: "error",
      error: { code: "runtime_error", message: "bad\u001b[31m\nforged\tline\\tail" },
    };
    await failed.output.finish(() => terminal);
    expect(failed.stderr.value).toBe("elwood: bad\\nforged\\tline\\\\tail\n");
  });
});
