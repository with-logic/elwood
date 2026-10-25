/**
 * A rejected user or persona turn reaches every headless output mode as `turn_failed` with exit
 * status 1, after cleanup (PRD §12A.2/§12A.5, C-CLI-28). The session facade's own rejection is
 * proven against the real Claude reader in tests/claude/rejected-turn.test.ts; this covers the
 * run core's mapping of that error in text, JSON and JSONL.
 */

import { expect, test } from "vitest";
import { executeRun } from "../../src/cli/run/index.ts";
import { AsyncOutputSink } from "../../src/cli/stream.ts";
import type { EffectiveRunRequest } from "../../src/cli/types.ts";
import { elwoodError } from "../../src/core/errors.ts";
import { FakeCliSession, FakeSignals, MemoryWriter } from "./run-fakes.ts";

const message = "Claude rejected the turn: model_not_found";
const rejected = () => elwoodError("turn_failed", message, { agentError: "model_not_found" });

/** A run whose user turn, or persona setup turn, the agent rejects. */
async function run(turn: "user" | "persona", output: EffectiveRunRequest["output"]) {
  const session = new FakeCliSession();
  session.events = [];
  if (turn === "persona") {
    session.setupWork = async (s) => {
      await s.start();
      throw rejected(); // HeadlessCliSession.setup() sends the persona as a real turn
    };
  } else session.streamWork = () => Promise.reject(rejected());
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();
  const request: EffectiveRunRequest = {
    agent: "claude",
    output,
    outputExplicit: output !== "text",
    trust: true,
    highTrust: false,
    stateDir: "/state",
    verbose: false,
    stream: false,
    cwd: "/work",
    images: [],
    prompt: "go",
    keep: false,
    ephemeral: false,
    ...(turn === "persona" ? { persona: "be careful" } : {}),
  };
  const streams = { stdout: new AsyncOutputSink(stdout), stderr: new AsyncOutputSink(stderr) };
  const status = await executeRun(request, session, streams, { signals: new FakeSignals() });
  return { status, stdout: stdout.value, stderr: stderr.value, teardowns: session.teardowns };
}

test.each([
  "user",
  "persona",
] as const)("C-CLI-28 a rejected %s turn in text mode exits 1 with the diagnostic on stderr", async (turn) => {
  const result = await run(turn, "text");
  expect(result).toMatchObject({ status: 1, stdout: "", teardowns: 1 });
  expect(result.stderr).toContain(`elwood: ${message}\n`);
});

test.each([
  ["user", "json"],
  ["persona", "json"],
  ["user", "jsonl"],
  ["persona", "jsonl"],
] as const)("C-CLI-28 a rejected %s turn in %s mode ends in a turn_failed error record", async (turn, output) => {
  const result = await run(turn, output);
  expect(result).toMatchObject({ status: 1, teardowns: 1 });
  const records = result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  if (output === "json") expect(records).toHaveLength(1);
  expect(records.at(-1)).toMatchObject({ type: "error", error: { code: "turn_failed", message } });
  expect(records.some((record) => record.type === "result")).toBe(false);
});
