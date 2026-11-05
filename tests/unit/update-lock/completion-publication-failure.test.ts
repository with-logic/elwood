/** Failed completion publication preserves the existing update lease (PRD §9.2, C-PERF-04). */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { preflightClaude } from "../../../src/claude/preflight.ts";
import { preflightCodex } from "../../../src/codex/preflight.ts";
import { elwoodError } from "../../../src/core/errors.ts";
import { setCommandRunnerForTests, setPlatformForTests } from "../../../src/runtime/seams.ts";
import { coordinatedAutoupdate, updateLockPath } from "../../../src/runtime/update/lock.ts";
import {
  resetAutoupdateForTests,
  resetPreflightCacheForTests,
  setUpdateCoordinatorForTests,
} from "../../../src/runtime/update/once.ts";
import { tempDir } from "../../helpers/tmp.ts";

const race = vi.hoisted(() => ({
  marker: "",
  denyPublication: false,
  afterOpen: undefined as undefined | (() => Promise<void>),
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (String(args[0]) === race.marker && race.afterOpen) {
        const after = race.afterOpen;
        race.afterOpen = undefined;
        await after();
      }
      return handle;
    },
    rename: (...args: Parameters<typeof actual.rename>) => {
      if (race.denyPublication && String(args[1]) === race.marker)
        return Promise.reject(Object.assign(new Error("publication denied"), { code: "EACCES" }));
      return actual.rename(...args);
    },
  };
});

test.each([
  ["codex", false],
  ["codex", true],
  ["claude", false],
  ["claude", true],
] as const)("C-PERF-04 %s retains ownership on publication failure (updater failure=%s)", async (agent, failed) => {
  const root = tempDir("elwood-update-publication-failure-");
  const lease = updateLockPath(agent, root);
  const ownerPath = join(lease, "owner");
  const completion = join(root, `${agent}.completed`);
  const previous = "00000000-0000-4000-8000-00000000000a";
  writeFileSync(completion, previous);
  const installerError = elwoodError(`${agent}_update_failed`, "Installer failed.", {
    errno: "EIO",
    exitStatus: 7,
    stderr: "installer failed",
  });
  const attempts: string[] = [];
  let ownerRecord: string | undefined;
  let ownerFailure: unknown;
  race.marker = completion;
  race.afterOpen = async () => {
    // C pins the old marker before B's entire update and failed publication.
    race.denyPublication = true;
    ownerFailure = await coordinatedAutoupdate(
      agent,
      () => {
        attempts.push("B");
        ownerRecord = readFileSync(ownerPath, "utf8");
        return failed ? Promise.reject(installerError) : Promise.resolve();
      },
      { root },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    race.denyPublication = false;
  };
  try {
    const contenderFailure = await coordinatedAutoupdate(
      agent,
      () => Promise.resolve(void attempts.push("C")),
      {
        root,
        pollMs: 1,
        waitMs: 100,
      },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(attempts).toEqual(["B"]);
    expect(contenderFailure).toMatchObject({
      code: `${agent}_update_failed`,
      details: { updateReason: "active_owner" },
    });
    expect(ownerRecord).toMatch(new RegExp(`^${process.pid}:[0-9a-f-]{36}$`));
    expect(readFileSync(ownerPath, "utf8")).toBe(ownerRecord);
    expect(readFileSync(completion, "utf8")).toBe(previous);
    if (failed) expect(ownerFailure).toBe(installerError);
    else
      expect(ownerFailure).toMatchObject({
        code: `${agent}_update_failed`,
        details: { errno: "EACCES" },
      });
    // The existing public best-effort path still permits a compatible installed CLI.
    resetAutoupdateForTests();
    resetPreflightCacheForTests();
    setPlatformForTests("darwin");
    setUpdateCoordinatorForTests(() => Promise.reject(ownerFailure));
    setCommandRunnerForTests(() => ({
      status: 0,
      stdout: agent === "codex" ? "codex-cli 0.150.0" : "2.1.305 (Claude Code)",
      stderr: "",
    }));
    const preflight = agent === "codex" ? preflightCodex : preflightClaude;
    expect(await preflight(false, true)).toMatchObject({
      code: "agent_update_failed",
      errorCode: failed ? "EIO" : "EACCES",
      raw: failed ? "installer failed" : "",
      ...(failed ? { exitStatus: 7 } : {}),
    });
    expect(existsSync(lease)).toBe(true);
  } finally {
    race.afterOpen = undefined;
    race.denyPublication = false;
  }
});
