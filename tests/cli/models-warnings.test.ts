/** Model-probe warnings respect resolved verbosity without changing results (C-CLI-10/26). */
import { expect, test } from "vitest";
import { main } from "../../src/cli/main.ts";
import { readErrorWarning } from "../../src/core/transcript/warnings.ts";
import { modelsHarness } from "./models-fakes.ts";

test.each([
  { args: [], env: {}, visible: false },
  { args: ["--output", "json"], env: {}, visible: false },
  { args: ["--verbose"], env: {}, visible: true },
  { args: ["--debug", "--output", "json"], env: {}, visible: true },
  { args: [], env: { ELWOOD_VERBOSE: "true" }, visible: true },
  { args: ["--no-verbose"], env: { ELWOOD_VERBOSE: "true" }, visible: false },
])("C-CLI-10/C-CLI-26 model warning visibility follows $args and $env", async ({
  args,
  env,
  visible,
}) => {
  const h = modelsHarness();
  const dependencies = {
    ...h.dependencies,
    prepare: async (...input: Parameters<typeof h.dependencies.prepare>) => {
      const prepared = await h.dependencies.prepare(...input);
      const session = h.sessions.at(-1)!;
      const list = session.underlying.listModels;
      session.underlying.listModels = () => {
        for (let index = 0; index < 3; index += 1) {
          session.emitter.emit(
            "warning",
            readErrorWarning(prepared.request.agent, {
              elwoodSessionId: "s1",
              path: "/transcript.jsonl",
              lastErrorCode: "ENOENT",
            }),
          );
        }
        return list();
      };
      return prepared;
    },
  };
  expect(await main(["models", ...args], { ...h.context, env }, dependencies)).toBe(0);
  expect(h.agents).toEqual(["claude", "codex"]);
  expect(h.stdout.value).toContain("claude-model");
  expect(h.stdout.value).toContain("codex-model");
  expect(h.stdout.value).not.toContain("transcript_read_error");
  expect(h.stderr.value.match(/transcript_read_error/g)?.length ?? 0).toBe(visible ? 6 : 0);
  expect(h.sessions.map((session) => session.teardowns)).toEqual([1, 1]);
});
