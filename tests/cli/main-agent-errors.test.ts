/**
 * Agent-selection failures at the CLI boundary: `no_agent_found` in every output
 * protocol, the real detector's message, and the `agent` field of error records
 * emitted before any adapter was selected (PRD §12A.1/§12A.3/§12A.5).
 */

import { afterEach, describe, expect, test } from "vitest";
import { main } from "../../src/cli/main.ts";
import { noAgentFoundMessage } from "../../src/cli/request/agent-detect.ts";
import { resolveRunRequest } from "../../src/cli/request/index.ts";
import { resetRuntimeSeamsForTests, setCommandRunnerForTests } from "../../src/runtime/seams.ts";
import { detectNothing } from "./agent-fakes.ts";
import { mainDependencies, mainHarness } from "./main-fakes.ts";

describe("CLI main agent-selection failures", () => {
  afterEach(() => {
    resetRuntimeSeamsForTests();
  });

  test("C-CLI-17/C-CLI-21 no installed agent is a status-2 configuration failure", async () => {
    const text = mainHarness();
    const resolve: typeof resolveRunRequest = (parsed, context) =>
      resolveRunRequest(parsed, context, detectNothing);
    expect(await main(["go"], text.context, mainDependencies({ resolve }))).toBe(2);
    expect(text.stdout.value).toBe("");
    expect(text.stderr.value).toBe("elwood: no agent (test)\n");
    const json = mainHarness();
    expect(
      await main(["--output", "json", "go"], json.context, mainDependencies({ resolve })),
    ).toBe(2);
    expect(JSON.parse(json.stdout.value)).toMatchObject({
      type: "error",
      agent: null,
      error: { code: "no_agent_found", message: "no agent (test)" },
    });
    const jsonl = mainHarness();
    expect(await main(["--output=jsonl", "go"], jsonl.context, mainDependencies({ resolve }))).toBe(
      2,
    );
    expect(JSON.parse(jsonl.stdout.value)).toMatchObject({
      sequence: 1,
      type: "error",
      agent: null,
      error: { code: "no_agent_found" },
    });
  });

  test("C-CLI-17/C-CLI-21 the real detector's failure reaches the CLI boundary", async () => {
    setCommandRunnerForTests(() => ({ status: 1, stdout: "", stderr: "" }));
    const h = mainHarness();
    expect(await main(["go"], h.context, mainDependencies({ resolve: resolveRunRequest }))).toBe(2);
    expect(h.stdout.value).toBe("");
    expect(h.stderr.value).toBe(`elwood: ${noAgentFoundMessage}\n`);
  });

  test("C-CLI-11 pre-selection error records report the selecting flag or env, else null", async () => {
    const env = mainHarness();
    expect(
      await main(
        ["--output", "json", "--trust", "--no-trust", "go"],
        { ...env.context, env: { ELWOOD_AGENT: "claude" } },
        mainDependencies(),
      ),
    ).toBe(2);
    expect(JSON.parse(env.stdout.value)).toMatchObject({
      agent: "claude",
      error: { code: "invalid_arguments" },
    });
    const ignored = mainHarness();
    expect(
      await main(
        ["--output", "json", "--no-defaults", "--trust", "--no-trust", "go"],
        { ...ignored.context, env: { ELWOOD_AGENT: "claude" } },
        mainDependencies(),
      ),
    ).toBe(2);
    expect(JSON.parse(ignored.stdout.value).agent).toBeNull();
    const invalid = mainHarness();
    expect(
      await main(
        ["--agent=gemini", "--output", "json", "--trust", "--no-trust", "go"],
        invalid.context,
        mainDependencies(),
      ),
    ).toBe(2);
    expect(JSON.parse(invalid.stdout.value).agent).toBeNull();
  });
});
