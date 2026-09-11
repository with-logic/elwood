/**
 * Stable text/JSON/JSONL validation and startup failures at the CLI boundary (PRD §12A.5).
 */

import { describe, expect, test } from "vitest";
import { main } from "../../src/cli/main.ts";
import { resolveRunRequest } from "../../src/cli/request/index.ts";
import { CliValidationError } from "../../src/cli/types.ts";
import { elwoodError } from "../../src/core/errors.ts";
import { detectCodex } from "./agent-fakes.ts";
import { mainDependencies, mainHarness, resolvedRequest } from "./main-fakes.ts";

/** Real request resolution with a deterministic detector, so no test probes the login shell. */
const resolveDetected: typeof resolveRunRequest = (parsed, context) =>
  resolveRunRequest(parsed, context, detectCodex);

describe("CLI main failures", () => {
  test("C-CLI-20 unknown options are actionable and suggest close matches", async () => {
    const h = mainHarness();
    expect(await main(["--verbsoe"], h.context)).toBe(2);
    expect(h.stdout.value).toBe("");
    expect(h.stderr.value).toBe("elwood: Unknown option '--verbsoe'. Did you mean '--verbose'?\n");
  });

  test("C-CLI-02/C-CLI-17 explicit run with empty terminal input is a usage error", async () => {
    const h = mainHarness();
    expect(await main(["run"], h.context, mainDependencies({ resolve: resolveDetected }))).toBe(2);
    expect(h.stdout.value).toBe("");
    expect(h.stderr.value).toBe("elwood: A non-empty prompt is required.\n");
  });

  test("C-CLI-11 explicit JSON preserves agent hint on argument failure", async () => {
    const h = mainHarness();
    expect(
      await main(
        ["--agent=claude", "--output", "json", "--trust", "--no-trust", "go"],
        h.context,
        mainDependencies(),
      ),
    ).toBe(2);
    expect(JSON.parse(h.stdout.value)).toMatchObject({
      type: "error",
      agent: "claude",
      cleanup: { action: "none", status: "succeeded" },
      error: { code: "invalid_arguments" },
    });
    expect(h.stderr.value).toBe("");

    const separated = mainHarness();
    expect(
      await main(
        ["--agent", "claude", "--output=json", "--unknown"],
        separated.context,
        mainDependencies(),
      ),
    ).toBe(2);
    expect(JSON.parse(separated.stdout.value).agent).toBe("claude");
  });

  test("C-CLI-11 explicit inline JSONL emits one sequenced validation error", async () => {
    const h = mainHarness();
    const deps = mainDependencies({ resolve: resolveDetected });
    expect(await main(["--output=jsonl", "--stream", "go"], h.context, deps)).toBe(2);
    expect(JSON.parse(h.stdout.value)).toMatchObject({
      schemaVersion: 1,
      sequence: 1,
      type: "error",
      error: { code: "invalid_arguments" },
    });
  });

  test("C-CLI-02/C-CLI-11 invalid or post-double-dash output selections retain text diagnostics", async () => {
    for (const args of [
      ["--output", "yaml", "go"],
      ["--unknown", "--", "--output", "json"],
      ["claude", "--unknown"],
      ["config", "unknown", "--output", "json"],
    ]) {
      const h = mainHarness();
      expect(await main(args, h.context, mainDependencies({ resolve: resolveDetected }))).toBe(2);
      expect(h.stdout.value).toBe("");
      expect(h.stderr.value).toContain("elwood:");
    }
  });

  test("C-CLI-20 text failures keep dynamic values on one diagnostic line", async () => {
    const h = mainHarness();
    expect(
      await main(
        ["go"],
        h.context,
        mainDependencies({
          resolve: () =>
            Promise.reject(
              new CliValidationError("invalid_arguments", "Workspace 'bad\npath' does not exist."),
            ),
        }),
      ),
    ).toBe(2);
    expect(h.stdout.value).toBe("");
    expect(h.stderr.value).toBe("elwood: Workspace 'bad\\npath' does not exist.\n");
  });

  test("C-CLI-11/C-CLI-17 resolved output handles typed and unknown startup failures", async () => {
    const typed = mainHarness();
    expect(
      await main(
        ["go"],
        typed.context,
        mainDependencies({
          resolve: () => Promise.resolve(resolvedRequest({ output: "json" })),
          prepare: () => Promise.reject(elwoodError("state_not_found", "State missing.")),
        }),
      ),
    ).toBe(1);
    expect(JSON.parse(typed.stdout.value).error).toEqual({
      code: "state_not_found",
      message: "State missing.",
    });

    const unknown = mainHarness();
    expect(
      await main(
        ["--output", "json", "go"],
        unknown.context,
        mainDependencies({ resolve: () => Promise.reject("private") }),
      ),
    ).toBe(1);
    expect(JSON.parse(unknown.stdout.value).error.code).toBe("runtime_error");
  });

  test("C-CLI-12 error rendering failures are contained and negative durations clamp", async () => {
    const h = mainHarness();
    h.stderr.write = (_value, callback) => {
      callback(new Error("closed"));
      return true;
    };
    const times = [10, 5];
    expect(
      await main(
        ["run"],
        h.context,
        mainDependencies({ resolve: resolveDetected, now: () => times.shift() ?? 5 }),
      ),
    ).toBe(2);
    expect(h.stdout.value).toBe("");
  });
});
