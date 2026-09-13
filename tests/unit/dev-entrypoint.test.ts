/**
 * Coverage for the manual test-app entrypoint guard.
 * Covers PRD §11: importing `dev.ts` has no side effects, and the bootstrap
 * launches a session only when the module is the process entry.
 */

import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { bootstrapDevAppIfMain, type DevAppProcess, runDevApp } from "../../dev/dev.ts";
import { fakeSharedSession } from "../helpers/fake-shared-session.ts";

const devUrl = new URL("../../dev/dev.ts", import.meta.url).href;

describe("dev app entrypoint", () => {
  test("C-APP-01 runDevApp starts a session through an injected runtime", async () => {
    const id = await runDevApp({
      proc: fakeProcess(["node", "dev.ts", "--cwd", "/w"]),
      runtime: fakeRuntime(),
    });
    expect(id).toBe("s1");
  });

  test("C-APP-08 bootstrapDevAppIfMain is inert when not the process entry", () => {
    const deps = { proc: fakeProcess(["node", "dev.ts"]), runtime: fakeRuntime() };
    expect(bootstrapDevAppIfMain({ url: "file:///not/the/entry.ts" }, deps)).toBeNull();
  });

  test("C-APP-08 bootstrapDevAppIfMain runs when the url matches the entry argv", async () => {
    const argv = process.argv;
    const restored = [...argv];
    try {
      argv[1] = fileURLToPath(devUrl);
      const result = bootstrapDevAppIfMain(
        { url: devUrl },
        { proc: fakeProcess(["node", "dev.ts"]), runtime: fakeRuntime() },
      );
      expect(result).not.toBeNull();
      await expect(result).resolves.toBe("s1");
    } finally {
      argv.splice(0, argv.length, ...restored);
    }
  });
});

function fakeProcess(argv: readonly string[]): DevAppProcess {
  return {
    argv,
    stdin: emptyStdin(),
    stdout: { write: () => true },
    stderr: { write: () => true },
  };
}

async function* emptyStdin(): AsyncIterable<string> {
  // No prompts: the session starts and the input loop finishes immediately.
}

function fakeRuntime() {
  const session = fakeSharedSession();
  return {
    startClaude: () => Promise.resolve(session),
    resumeClaude: () => Promise.resolve(session),
    startCodex: () => Promise.resolve(session),
    resumeCodex: () => Promise.resolve(session),
  };
}
