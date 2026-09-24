/** Changed update generations renew bounded CLI grace (PRD §5.5, C-CODEX-12/C-CLI-05). */
import { expect, test } from "vitest";
import { executeRun } from "../../src/cli/run/index.ts";
import { AsyncOutputSink } from "../../src/cli/stream.ts";
import { codexUpdateAttentionGraceMs } from "../../src/cli/update-attention.ts";
import { effectiveRequest } from "./main-fakes.ts";
import { FakeCliSession, FakeClock, FakeSignals, MemoryWriter } from "./run-fakes.ts";

test.each([
  false,
  true,
])("C-CLI-05 changed generation rearms once (ordinary first: %s)", async (ordinaryFirst) => {
  const session = new FakeCliSession();
  const clock = new FakeClock();
  const stdout = new MemoryWriter();
  const same: boolean[] = [];
  session.setupWork = async (current) => {
    await current.start();
    current.underlying.status = "blocked";
    const attention = (promptGeneration?: number) =>
      current.emitActivity({
        label: "codex-update-prompt",
        ...(promptGeneration === undefined ? {} : { promptGeneration }),
      });
    if (ordinaryFirst) attention();
    attention(3);
    if (!ordinaryFirst) attention();
    const before = clock.handler;
    attention(3);
    attention(2);
    same.push(clock.handler === before);
    attention(5);
    same.push(clock.handler === before);
    attention(3);
    attention();
    clock.fire();
    await new Promise(() => {});
  };
  expect(
    await executeRun(
      effectiveRequest({ output: "json" }),
      session,
      {
        stdout: new AsyncOutputSink(stdout),
        stderr: new AsyncOutputSink(new MemoryWriter()),
      },
      { clock, signals: new FakeSignals() },
    ),
  ).toBe(1);
  expect(same).toEqual([true, false]);
  expect(clock.delays).toEqual(new Array(ordinaryFirst ? 3 : 2).fill(codexUpdateAttentionGraceMs));
  expect(JSON.parse(stdout.value).error.code).toBe("blocked_prompt");
  expect(session.kills).toBe(1);
});
