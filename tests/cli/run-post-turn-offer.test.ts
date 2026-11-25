/**
 * Claude's auto-mode offer fails a headless run only before the prompt's own turn has
 * returned to `ready` (PRD §12A.2, C-CLI-05, C-ATTN-09).
 */
import { expect, test } from "vitest";
import { executeRun } from "../../src/cli/run/index.ts";
import { AsyncOutputSink } from "../../src/cli/stream.ts";
import type { ElwoodSessionStatus } from "../../src/core/types.ts";
import { effectiveRequest } from "./main-fakes.ts";
import { FakeCliSession, FakeSignals, MemoryWriter } from "./run-fakes.ts";

const offer = "claude-auto-mode-offer";

/** Runs with `setup` statuses before the prompt and `turn` statuses after it, then the offer. */
async function runWithOffer(
  setup: readonly ElwoodSessionStatus[],
  turn: readonly ElwoodSessionStatus[],
) {
  const session = new FakeCliSession();
  const emit = (statuses: readonly ElwoodSessionStatus[]) => {
    for (const status of statuses)
      session.emitter.emit("status", { elwoodSessionId: "s1", status });
  };
  session.setupWork = async (current) => {
    await current.start();
    emit(setup);
  };
  session.streamWork = (current) => {
    emit(turn);
    current.emitActivity({ label: offer });
    return Promise.resolve();
  };
  const stdout = new MemoryWriter();
  const io = {
    stdout: new AsyncOutputSink(stdout),
    stderr: new AsyncOutputSink(new MemoryWriter()),
  };
  const code = await executeRun(effectiveRequest({ output: "json" }), session, io, {
    signals: new FakeSignals(),
  });
  const record = JSON.parse(stdout.value) as { readonly type: string; readonly error?: unknown };
  return { code, record, kills: session.kills };
}

test("C-CLI-05 the offer after the prompt's turn returns to ready does not fail the run", async () => {
  const { code, record, kills } = await runWithOffer([], ["running", "ready", "blocked"]);
  expect(record.type).toBe("result");
  expect(code).toBe(0);
  expect(kills).toBe(0);
});

test.each([
  { case: "after a setup turn, before the prompt's turn", setup: ["running", "ready"], turn: [] },
  { case: "while the prompt's turn is still running", setup: [], turn: ["ready", "running"] },
] as const)("C-CLI-05 the offer $case fails the run as blocked_prompt", async (example) => {
  const { code, record } = await runWithOffer(example.setup, example.turn);
  expect(record.error).toEqual({ code: "blocked_prompt", message: `Blocked prompt: ${offer}.` });
  expect(code).toBe(1);
});
