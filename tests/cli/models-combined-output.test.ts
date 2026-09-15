/** Aggregate rendering sanitizes rows and settles output failures after cleanup (C-CLI-26). */
import { expect, test } from "vitest";
import { main } from "../../src/cli/main.ts";
import type { CliWritable } from "../../src/cli/stream.ts";
import { modelsHarness } from "./models-fakes.ts";
import { FakeSignals } from "./run-fakes.ts";

test("C-CLI-26 combined tables mark defaults and sanitize every model field", async () => {
  const h = modelsHarness();
  const dependencies = {
    ...h.dependencies,
    prepare: async (...input: Parameters<typeof h.dependencies.prepare>) => {
      const prepared = await h.dependencies.prepare(...input);
      h.sessions.at(-1)!.underlying.listModels = () =>
        Promise.resolve([
          {
            id: "\u001b[31mid",
            label: "\u001b[31mlabel",
            description: "\u001b[31mdescription",
            raw: "\u001b[31mraw",
            isCurrent: false,
            isDefault: true,
          },
        ]);
      return prepared;
    },
  };
  expect(await main(["models"], h.context, dependencies)).toBe(0);
  expect(h.stdout.value).toContain("(default)");
  expect(h.stdout.value).toContain("description");
  expect(h.stdout.value).not.toContain("\u001b");
});

test("C-CLI-26 a rejected aggregate stdout write causes no retry or leaked signal listener", async () => {
  const h = modelsHarness();
  const signals = new FakeSignals();
  let writes = 0;
  const stdout: CliWritable = {
    write: (_value, callback) => {
      writes += 1;
      callback(new Error("write failed"));
      return true;
    },
    once: () => undefined,
  };
  expect(
    await main(["models", "--output", "json"], { ...h.context, stdout, signals }, h.dependencies),
  ).toBe(1);
  expect(writes).toBe(1);
  expect(h.sessions.map((session) => session.teardowns)).toEqual([1, 1]);
  expect(signals.unbound).toBe(true);
});

test("C-CLI-26 a warning write failure cleans the active probe and prevents another launch", async () => {
  const h = modelsHarness();
  const signals = new FakeSignals();
  const stderr: CliWritable = {
    write: (_value, callback) => {
      callback(new Error("write failed"));
      return true;
    },
    once: () => undefined,
  };
  const dependencies = {
    ...h.dependencies,
    prepare: async (...input: Parameters<typeof h.dependencies.prepare>) => {
      const prepared = await h.dependencies.prepare(...input);
      h.sessions[0]!.underlying.listModels = () => {
        h.sessions[0]!.emitter.emit("warning", {
          elwoodSessionId: "s1",
          agent: "claude",
          source: "lifecycle",
          code: "version_unparseable",
          severity: "warning",
          message: "odd version",
          raw: "",
        });
        return Promise.resolve([]);
      };
      return prepared;
    },
  };
  expect(
    await main(
      ["models", "--output", "json", "--verbose"],
      { ...h.context, stderr, signals },
      dependencies,
    ),
  ).toBe(1);
  expect(h.agents).toEqual(["claude"]);
  expect(h.sessions[0]!.teardowns).toBe(1);
  expect(JSON.parse(h.stdout.value)).toMatchObject({
    type: "error",
    error: { code: "runtime_error" },
  });
  expect(signals.unbound).toBe(true);
});
