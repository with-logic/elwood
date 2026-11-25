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
  label = offer,
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
    current.emitActivity({ label });
    return Promise.resolve();
  };
  const stdout = new MemoryWriter();
  const io = {
    stdout: new AsyncOutputSink(stdout),
    stderr: new AsyncOutputSink(new MemoryWriter()),
  };
  const code = await executeRun(
    effectiveRequest({ agent: "claude", output: "json" }),
    session,
    io,
    {
      signals: new FakeSignals(),
    },
  );
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
  { case: "the offer after a setup turn", setup: ["running", "ready"], turn: [], label: offer },
  {
    case: "the offer during the prompt's turn",
    setup: [],
    turn: ["ready", "running"],
    label: offer,
  },
  {
    case: "another dialog after the prompt's turn",
    setup: [],
    turn: ["running", "ready", "blocked"],
    label: "claude-permission-dialog",
  },
] as const)("C-CLI-05 $case fails the run as blocked_prompt", async (example) => {
  const { code, record } = await runWithOffer(example.setup, example.turn, example.label);
  expect(record.error).toEqual({
    code: "blocked_prompt",
    message: `Blocked prompt: ${example.label}.`,
  });
  expect(code).toBe(1);
});
