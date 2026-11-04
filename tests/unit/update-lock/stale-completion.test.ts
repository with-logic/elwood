/** Stale recovery never bypasses a peer’s completed generation (C-PERF-04). */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { coordinatedAutoupdate, updateLockPath } from "../../../src/runtime/update/lock.ts";
import { tempDir } from "../../helpers/tmp.ts";

const window = vi.hoisted(() => ({
  marker: "",
  recovery: "",
  afterSnapshot: undefined as undefined | (() => Promise<void>),
  afterRecovery: undefined as undefined | (() => Promise<void>),
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const text = await actual.readFile(...args);
      if (String(args[0]) === window.marker && window.afterSnapshot) {
        const after = window.afterSnapshot;
        window.afterSnapshot = undefined;
        await after();
      }
      return text;
    },
    rmdir: async (...args: Parameters<typeof actual.rmdir>) => {
      await actual.rmdir(...args);
      if (String(args[0]) === window.recovery && window.afterRecovery) {
        const after = window.afterRecovery;
        window.afterRecovery = undefined;
        await after();
      }
    },
  };
});

test.each([
  { scenario: "owner-completed", expected: [] },
  { scenario: "peer-after-recovery", expected: ["peer"] },
  { scenario: "abandoned", expected: ["contender"] },
] as const)("C-PERF-04 stale recovery respects $scenario completion state", async ({
  scenario,
  expected,
}) => {
  const root = tempDir("elwood-stale-completion-");
  const leasePath = updateLockPath("codex", root);
  window.marker = join(root, "codex.completed");
  window.recovery = `${leasePath}.recovery`;
  const generation = "00000000-0000-4000-8000-000000000000";
  mkdirSync(leasePath);
  writeFileSync(join(leasePath, "owner"), `99999999:${generation}`);
  writeFileSync(window.marker, "before");
  const attempts: string[] = [];
  const options = { root, pollMs: 1, staleMs: 0 };
  if (scenario === "owner-completed")
    window.afterSnapshot = () => {
      // Publish the observed owner's last completion after its contender sampled the marker.
      writeFileSync(window.marker, generation);
      return Promise.resolve();
    };
  if (scenario === "peer-after-recovery")
    window.afterRecovery = async () => {
      await coordinatedAutoupdate(
        "codex",
        () => Promise.resolve(void attempts.push("peer")),
        options,
      );
    };
  try {
    await coordinatedAutoupdate(
      "codex",
      () => Promise.resolve(void attempts.push("contender")),
      options,
    );
    expect(attempts).toEqual(expected);
    expect(readFileSync(window.marker, "utf8")).not.toBe("before");
    expect(existsSync(leasePath)).toBe(false);
  } finally {
    window.afterSnapshot = undefined;
    window.afterRecovery = undefined;
  }
});
