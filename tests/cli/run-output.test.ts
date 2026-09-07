/**
 * Human and structured execution-output orchestration tests (PRD §12A.3).
 */

import { describe, expect, test } from "vitest";
import type { CliError, CliResult } from "../../src/cli/output/types.ts";
import { RunOutput } from "../../src/cli/run-output.ts";
import { AsyncOutputSink } from "../../src/cli/stream.ts";
import type { EffectiveRunRequest } from "../../src/cli/types.ts";
import type { ElwoodWarningEvent } from "../../src/core/types.ts";
import { MemoryWriter } from "./run-fakes.ts";

const request = (overrides: Partial<EffectiveRunRequest> = {}): EffectiveRunRequest => ({
  agent: "codex",
  output: "text",
  outputExplicit: false,
  trust: true,
  stateDir: "/state",
  verbose: false,
  stream: false,
  cwd: "/work",
  images: [],
  prompt: "go",
  keep: false,
  ephemeral: false,
  sandbox: "workspace-write",
  approvalPolicy: "never",
  ...overrides,
});

const terminal = (overrides: Partial<Omit<CliResult, "type">> = {}): CliResult => ({
  schemaVersion: 1,
  type: "result",
  agent: "codex",
  response: "one\n\ntwo",
  sessionId: null,
  durationMs: 1,
  cleanup: { action: "teardown", status: "succeeded" },
  ...overrides,
});

const errorTerminal = (
  overrides: Partial<Omit<CliError, "type" | "error">> & {
    readonly error?: CliError["error"];
  } = {},
): CliError => ({
  ...terminal(),
  type: "error",
  error: { code: "runtime_error", message: "Failed." },
  ...overrides,
});

const warning: ElwoodWarningEvent = {
  elwoodSessionId: "s1",
  agent: "codex",
  source: "lifecycle",
  code: "version_unparseable",
  severity: "warning",
  message: "version warning",
  raw: "raw",
};

function harness(effective: EffectiveRunRequest, elapsedMs = 0) {
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();
  const closed: boolean[] = [];
  const failed: unknown[] = [];
  const output = new RunOutput(
    effective,
    new AsyncOutputSink(stdout),
    new AsyncOutputSink(stderr),
    { consumerClosed: () => closed.push(true), failed: (error) => failed.push(error) },
    () => elapsedMs,
  );
  return { output, stdout, stderr, closed, failed };
}

describe("RunOutput", () => {
  test("C-CLI-10 final text accumulates messages and ignores progress after finish", async () => {
    const h = harness(request());
    await h.output.turn({ type: "text", text: "one" });
    await h.output.turn({ type: "text", text: "two" });
    expect(h.output.response).toBe("one\n\ntwo");
    await h.output.finish(() => terminal());
    await h.output.turn({ type: "text", text: "late" });
    expect(h.stdout.value).toBe("one\n\ntwo\n");
    expect(h.stderr.value).toBe("");
  });

  test("C-CLI-10 warnings surface on text and JSON stderr without JSONL duplication", async () => {
    for (const output of ["text", "json"] as const) {
      const h = harness(request({ output }));
      h.output.warning(warning);
      await h.output.finish(() => terminal());
      expect(h.stderr.value).toBe("elwood: warning [version_unparseable]: version warning\n");
    }
    const jsonl = harness(request({ output: "jsonl" }));
    jsonl.output.warning(warning);
    await jsonl.output.finish(() => terminal());
    expect(jsonl.stderr.value).toBe("");
    expect(jsonl.stdout.value).toContain('"type":"warning"');
  });

  test("C-CLI-10 stream emits text once and verbose stays concise", async () => {
    const h = harness(request({ stream: true, verbose: true }), 2_100);
    h.output.setSecrets(["token"]);
    h.output.starting();
    h.output.status({ schemaVersion: 1, type: "status", status: "running" });
    h.output.warning(warning);
    await h.output.turn({ type: "thinking", text: "why" });
    h.output.runningPrompt();
    await h.output.turn({ type: "tool_call", name: "exec", input: "secret input" });
    await h.output.turn({ type: "tool_result", output: "done token" });
    await h.output.turn({ type: "text", text: "one token" });
    expect(h.output.response).toBe(""); // streaming does not retain a duplicate response
    await h.output.finish(() => terminal({ response: "one [REDACTED]" }));
    expect(h.stdout.value).toBe("one [REDACTED]\n");
    expect(h.stderr.value).toContain("[2.1s] Starting Codex in /work\n");
    expect(h.stderr.value).toContain("[2.1s] Running prompt\n[2.1s] Tool: exec\n");
    expect(h.stderr.value).toContain("[2.1s] Warning version_unparseable: version warning\n");
    expect(h.stderr.value).toContain("[2.1s] Completed; session removed\n");
    expect(h.stderr.value).not.toContain("secret input");
    expect(h.stderr.value).not.toContain("[assistant]");
    expect(h.stderr.value).not.toContain("[thinking]");
  });

  test("C-CLI-10 debug emits full sanitized normalized event detail", async () => {
    const h = harness(request({ debug: true }), 500);
    h.output.status({ schemaVersion: 1, type: "status", status: "running" });
    h.output.warning(warning);
    await h.output.turn({ type: "thinking", text: "why" });
    await h.output.turn({ type: "tool_call", name: "exec", input: "pwd" });
    await h.output.turn({ type: "tool_result" });
    await h.output.turn({ type: "text", text: "answer" });
    await h.output.finish(() => terminal());
    expect(h.stderr.value).toContain("[0.5s] [status] running");
    expect(h.stderr.value).toContain("[0.5s] [thinking] why");
    expect(h.stderr.value).toContain("[0.5s] [tool call] exec pwd");
    expect(h.stderr.value).toContain("[0.5s] [tool result] unknown");
    expect(h.stderr.value).toContain("[0.5s] [assistant] answer");
    expect(h.stderr.value).toContain("[0.5s] [warning version_unparseable] version warning");
  });

  test("C-CLI-11 JSON and JSONL select only their machine protocols", async () => {
    const json = harness(request({ output: "json" }));
    await json.output.finish(() => terminal());
    expect(JSON.parse(json.stdout.value)).toMatchObject({ type: "result", response: "one\n\ntwo" });
    expect(json.stderr.value).toBe("");

    const jsonl = harness(request({ output: "jsonl", verbose: true }));
    await jsonl.output.turn({ type: "tool_call", name: "read", input: "file" });
    await jsonl.output.finish(() => terminal());
    const records = jsonl.stdout.value
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records.map((record) => record.type)).toEqual(["tool", "result"]);
    expect(jsonl.stderr.value).toContain("[0.0s] Tool: read");
    expect(jsonl.stderr.value).not.toContain("file");
  });

  test("text errors and kept identities stay on stderr", async () => {
    const h = harness(request({ keep: true }));
    await h.output.finish(() =>
      errorTerminal({
        sessionId: "s1",
        cleanup: { action: "preserve", status: "succeeded" },
        error: { code: "agent_exited", message: "Agent exited." },
      }),
    );
    expect(h.stderr.value).toBe("elwood: Agent exited.\nelwood: session s1\n");
  });

  test("EPIPE latches consumer closure and suppresses text diagnostics", async () => {
    const h = harness(request({ stream: true }));
    h.stdout.failAt = 1;
    await h.output.turn({ type: "text", text: "partial" });
    await h.output.finish(() =>
      errorTerminal({ error: { code: "timeout", message: "Timed out." } }),
    );
    expect(h.closed).toEqual([true, true]);
    expect(h.stderr.value).toBe("");
  });

  test("progress write failures notify the lifecycle hook", async () => {
    const h = harness(request({ output: "jsonl" }));
    h.stdout.write = (_value, callback) => {
      callback(new Error("stdout failed"));
      return true;
    };
    await h.output.turn({ type: "tool_call", name: "read" });
    await h.output.flush();
    expect(h.failed).toHaveLength(1);
  });
});
