/** Shared time budgets and interruption stop later model probes (PRD §12A.10, C-CLI-26). */
import { expect, test } from "vitest";
import { main } from "../../src/cli/main.ts";
import { executeModels } from "../../src/cli/models/index.ts";
import { modelsHarness } from "./models-fakes.ts";
import { FakeClock, FakeSignals } from "./run-fakes.ts";

const args = ["models", "--timeout", "100ms", "--output", "json"];

test("C-CLI-26 the second probe receives only the remaining whole-command timeout", async () => {
  const h = modelsHarness();
  const clock = new FakeClock();
  const seen: number[] = [];
  const dependencies = {
    ...h.dependencies,
    now: clock.now,
    listModels: async (...input: Parameters<typeof executeModels>) => {
      seen.push(input[0].timeoutMs!);
      const status = await executeModels(input[0], input[1], input[2], { ...input[3], clock });
      clock.value += 60;
      return status;
    },
  };
  expect(await main(args, h.context, dependencies)).toBe(0);
  expect(seen).toEqual([100, 40]);
  expect(h.sessions.map((session) => session.teardowns)).toEqual([1, 1]);
});

test("C-CLI-26 an exhausted budget retains the first catalog without preparing the second", async () => {
  const h = modelsHarness();
  const clock = new FakeClock();
  const dependencies = {
    ...h.dependencies,
    now: clock.now,
    listModels: async (...input: Parameters<typeof executeModels>) => {
      const status = await executeModels(input[0], input[1], input[2], { ...input[3], clock });
      clock.value = 100;
      return status;
    },
  };
  expect(await main(args, h.context, dependencies)).toBe(124);
  expect(h.agents).toEqual(["claude"]);
  expect(JSON.parse(h.stdout.value)).toMatchObject({
    agents: [{ agent: "claude" }],
    errors: [{ agent: "codex", error: { code: "timeout" } }],
  });
});

test.each([
  false,
  true,
])("C-CLI-26 preparation exhausting the budget cleans up; cleanup failure=%s", async (failCleanup) => {
  const h = modelsHarness();
  const clock = new FakeClock();
  const dependencies = {
    ...h.dependencies,
    now: clock.now,
    prepare: async (...input: Parameters<typeof h.dependencies.prepare>) => {
      const prepared = await h.dependencies.prepare(...input);
      if (failCleanup) h.sessions[0]!.cleanupError = new Error("cleanup");
      clock.value = 100;
      return prepared;
    },
  };
  expect(await main(args, h.context, dependencies)).toBe(124);
  expect(h.agents).toEqual(["claude"]);
  expect(h.sessions[0]!.started).toBe(false);
  expect(h.sessions[0]!.teardowns).toBe(1);
  expect(JSON.parse(h.stdout.value).errors[0]).toMatchObject({
    error: { code: "timeout" },
    cleanup: { status: failCleanup ? "failed" : "succeeded" },
  });
});

test.each([
  "settings",
  "prepare",
  "picker",
  "before-launch",
])("C-CLI-26 SIGINT during %s prevents the next probe", async (phase) => {
  const h = modelsHarness();
  const signals = new FakeSignals();
  const dependencies = {
    ...h.dependencies,
    settings: async (...input: Parameters<typeof h.dependencies.settings>) => {
      const request = await h.dependencies.settings(...input);
      if (phase === "settings") signals.emit();
      return request;
    },
    prepare: async (...input: Parameters<typeof h.dependencies.prepare>) => {
      const prepared = await h.dependencies.prepare(...input);
      if (phase === "prepare") signals.emit();
      if (phase === "picker")
        h.sessions[0]!.underlying.listModels = () => {
          signals.emit();
          return new Promise(() => undefined);
        };
      return prepared;
    },
    listModels: (...input: Parameters<typeof executeModels>) => {
      if (phase === "before-launch") signals.emit();
      return executeModels(...input);
    },
  };
  expect(await main(["models", "--output", "json"], { ...h.context, signals }, dependencies)).toBe(
    130,
  );
  expect(h.agents).toEqual(phase === "settings" ? [] : ["claude"]);
  expect(h.sessions.every((session) => session.teardowns === 1)).toBe(true);
  expect(signals.unbound).toBe(true);
});

test.each([
  { agent: "claude", stop: "interrupted", status: 130 },
  { agent: "claude", stop: "timeout", status: 124 },
  { agent: "codex", stop: "interrupted", status: 130 },
  { agent: "codex", stop: "timeout", status: 124 },
] as const)("C-CLI-26 $stop takes precedence when $agent preparation rejects", async ({
  agent,
  stop,
  status,
}) => {
  const h = modelsHarness(agent);
  const clock = new FakeClock();
  const signals = new FakeSignals();
  const dependencies = {
    ...h.dependencies,
    now: clock.now,
    prepare: (...input: Parameters<typeof h.dependencies.prepare>) => {
      if (input[0].agent === agent) {
        if (stop === "interrupted") signals.emit();
        else clock.value = 100;
      }
      return h.dependencies.prepare(...input);
    },
    listModels: (...input: Parameters<typeof executeModels>) =>
      executeModels(input[0], input[1], input[2], { ...input[3], clock }),
  };
  expect(await main(args, { ...h.context, signals }, dependencies)).toBe(status);
  expect(h.agents).toEqual(agent === "claude" ? ["claude"] : ["claude", "codex"]);
  const output = JSON.parse(h.stdout.value);
  expect(output.agents).toEqual(
    agent === "claude"
      ? []
      : [{ agent: "claude", models: [expect.objectContaining({ id: "claude-model" })] }],
  );
  expect(output.errors).toEqual([
    expect.objectContaining({
      agent,
      error: { code: stop, message: stop === "interrupted" ? "Interrupted." : "Timed out." },
    }),
  ]);
  expect(h.sessions.map((session) => session.teardowns)).toEqual(agent === "claude" ? [] : [1]);
  expect(signals.unbound).toBe(true);
  expect(signals.handler).toBeUndefined();
  expect(clock.handler).toBeUndefined();
});
