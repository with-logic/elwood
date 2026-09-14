/** Combined model catalogs preserve association, partial failures, and output contracts (C-CLI-26). */
import { describe, expect, test } from "vitest";
import { main } from "../../src/cli/main.ts";
import { modelsHarness as harness } from "./models-fakes.ts";

describe("combined models", () => {
  test("C-CLI-26 bare models returns both associated catalogs as one JSON document", async () => {
    const h = harness();
    expect(await main(["models", "--output", "json"], h.context, h.dependencies)).toBe(0);
    expect(h.agents).toEqual(["claude", "codex"]);
    expect(JSON.parse(h.stdout.value)).toMatchObject({
      schemaVersion: 1,
      type: "models",
      errors: [],
      agents: [
        { agent: "claude", models: [{ id: "claude-model" }] },
        { agent: "codex", models: [{ id: "codex-model" }] },
      ],
    });
    expect(h.sessions.map((session) => session.teardowns)).toEqual([1, 1]);
  });

  test.each([
    "claude",
    "codex",
  ] as const)("C-CLI-26 %s failure retains the other catalog", async (fail) => {
    const h = harness(fail);
    expect(await main(["models", "--output", "json"], h.context, h.dependencies)).toBe(1);
    const document = JSON.parse(h.stdout.value);
    expect(document.agents).toHaveLength(1);
    expect(document.errors).toMatchObject([{ agent: fail, error: { code: "runtime_error" } }]);
    expect(h.agents).toEqual(["claude", "codex"]);
  });
});

test("C-CLI-26 combined text associates rows and names failed adapters", async () => {
  const h = harness("claude");
  expect(await main(["models"], h.context, h.dependencies)).toBe(1);
  expect(h.stdout.value).toContain("AGENT  CURRENT");
  expect(h.stdout.value).toContain("codex  *");
  expect(h.stderr.value).toBe("elwood: claude: Elwood could not run the agent.\n");
});

test("C-CLI-26 a picker failure preserves the following catalog", async () => {
  const h = harness();
  const prepare = h.dependencies.prepare;
  const dependencies = {
    ...h.dependencies,
    prepare: async (...args: Parameters<typeof prepare>) => {
      const prepared = await prepare(...args);
      if (args[0].agent === "claude")
        h.sessions[0]!.underlying.listModels = () => Promise.reject(new Error("picker"));
      return prepared;
    },
  };
  expect(await main(["models", "--output", "json"], h.context, dependencies)).toBe(1);
  expect(JSON.parse(h.stdout.value)).toMatchObject({
    agents: [{ agent: "codex" }],
    errors: [{ agent: "claude", cleanup: { action: "teardown" } }],
  });
});

test("C-CLI-26 invalid adapter settings report a partial result without launching that adapter", async () => {
  const h = harness();
  expect(
    await main(
      ["models", "--output", "json"],
      {
        ...h.context,
        env: { ELWOOD_CLAUDE_PERMISSION_MODE: "invalid" },
      },
      h.dependencies,
    ),
  ).toBe(2);
  expect(h.agents).toEqual(["codex"]);
  expect(JSON.parse(h.stdout.value).errors).toMatchObject([
    { agent: "claude", error: { code: "invalid_arguments" } },
  ]);
});

test("C-CLI-26 JSONL is rejected before either adapter is prepared", async () => {
  const h = harness();
  expect(await main(["models", "--output", "jsonl"], h.context, h.dependencies)).toBe(2);
  expect(h.agents).toEqual([]);
  expect(JSON.parse(h.stdout.value).error.code).toBe("invalid_arguments");
});
