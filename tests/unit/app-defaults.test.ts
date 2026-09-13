/**
 * Default runtime and argument fallbacks for the local dev apps.
 * Covers PRD §11 (C-APP-01) and §10 (C-ERR-02).
 */

import { describe, expect, test } from "vitest";
import { startAgentSession } from "../../dev/agent-runtime.ts";
import { parseTestAppArgs, runTestApp } from "../../dev/test-app.ts";
import { resetRuntimeSeamsForTests, setPlatformForTests } from "../../src/runtime/seams.ts";

describe("dev app default runtimes", () => {
  test("C-APP-01 C-ERR-02 startAgentSession defaults to the real adapters", async () => {
    setPlatformForTests("linux");
    try {
      await expect(
        startAgentSession({
          agent: "claude",
          cwd: "/tmp/project",
          size: { cols: 80, rows: 24 },
          hooks: {},
        }),
      ).rejects.toMatchObject({ code: "unsupported_platform" });
    } finally {
      resetRuntimeSeamsForTests();
    }
  });

  test("C-APP-01 C-ERR-02 runTestApp defaults to the real adapters", async () => {
    setPlatformForTests("linux");
    try {
      await expect(
        runTestApp(["--cwd", "/tmp/project"], {
          stdin: chunks([]),
          stdout: new Sink(),
          stderr: new Sink(),
        }),
      ).rejects.toMatchObject({ code: "unsupported_platform" });
    } finally {
      resetRuntimeSeamsForTests();
    }
  });

  test("C-APP-01 the test app cwd defaults to the current working directory", () => {
    expect(parseTestAppArgs([]).cwd).toBe(process.cwd());
  });
});

async function* chunks(
  values: readonly (string | Uint8Array)[],
): AsyncIterable<string | Uint8Array> {
  for (const value of values) {
    await Promise.resolve();
    yield value;
  }
}

class Sink {
  text = "";

  write(chunk: string): void {
    this.text += chunk;
  }
}
