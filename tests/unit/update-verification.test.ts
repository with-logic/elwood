/** A rejected pre-update verification neither completes nor caches an update (PRD §9.2, C-LIFE-09). */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import { preflightClaude } from "../../src/claude/preflight.ts";
import { preflightCodex } from "../../src/codex/preflight.ts";
import { setCommandRunnerForTests, setPlatformForTests } from "../../src/runtime/seams.ts";
import { coordinatedAutoupdate } from "../../src/runtime/update/lock.ts";
import {
  cachedAutoupdate,
  resetAutoupdateForTests,
  resetPreflightCacheForTests,
  setUpdateCoordinatorForTests,
} from "../../src/runtime/update/once.ts";
import { tempDir } from "../helpers/tmp.ts";

beforeEach(() => {
  resetAutoupdateForTests();
  resetPreflightCacheForTests();
  setPlatformForTests("darwin");
});
for (const [agent, version, preflight] of [
  ["claude", "2.1.144", preflightClaude],
  ["codex", "codex-cli 0.150.0", preflightCodex],
] as const) {
  test(`C-LIFE-09 ${agent} retries after verification failed without running its updater`, async () => {
    const root = tempDir("elwood-update-verify-");
    setUpdateCoordinatorForTests((adapter, update) =>
      coordinatedAutoupdate(adapter, update, { root }),
    );
    let versions = 0;
    let updates = 0;
    setCommandRunnerForTests((_command, args) => {
      if (args.join(" ").includes(`${agent} update`)) {
        updates += 1;
        return { status: 0, stdout: "", stderr: "" };
      }
      return ++versions === 1
        ? { status: 1, stdout: "", stderr: "verification refused" }
        : { status: 0, stdout: version, stderr: "" };
    });
    const first = await preflight(false, true);
    const completionAfterRefusal = existsSync(join(root, `${agent}.completed`));
    const second = await preflight(false, true);
    expect({ first: first?.code, second: second?.code, completionAfterRefusal, updates }).toEqual({
      first: undefined,
      second: undefined,
      completionAfterRefusal: false,
      updates: 1,
    });
  });
}

test("C-LIFE-09 concurrent sharers retry their own verification after a no-attempt owner", async () => {
  const root = tempDir("elwood-update-verify-sharers-");
  setUpdateCoordinatorForTests((adapter, update) =>
    coordinatedAutoupdate(adapter, update, { root }),
  );
  const entered = Promise.withResolvers<void>();
  const verification = Promise.withResolvers<void>();
  const updates: string[] = [];
  const refused = cachedAutoupdate("codex", {
    verify: () => {
      entered.resolve();
      return verification.promise;
    },
    update: () => {
      updates.push("refused");
      return Promise.resolve();
    },
  });
  await entered.promise;
  const accepted = Array.from({ length: 3 }, () =>
    cachedAutoupdate("codex", {
      verify: () => Promise.resolve(),
      update: () => {
        updates.push("accepted");
        return Promise.resolve();
      },
    }),
  );
  verification.reject(new Error("prerequisite refused"));
  expect(await Promise.all([refused, ...accepted])).toEqual(
    Array.from({ length: 4 }, () => ({ ok: true })),
  );
  expect(updates).toEqual(["accepted"]);
});
