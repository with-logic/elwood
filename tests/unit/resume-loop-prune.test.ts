/**
 * A resume prunes its expired loops through the launch's publication: a resume that succeeds
 * keeps the pruned sidecar, and one that fails restores the sidecar it found, as it restores
 * every other file it published (PRD §5.9, §8.1, C-API-20, C-LOOP-13).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { LOOP_EXPIRATION_MS } from "../../src/core/loops/constants.ts";
import { resumeClaude, resumeCodex } from "../../src/index.ts";
import { setPtyFactoryForTests } from "../../src/runtime/seams.ts";
import { safeSessionDir } from "../../src/state/files.ts";
import { type PersistedLoopDefinition, writeLoopDefinitions } from "../../src/state/loop-store.ts";
import {
  createSessionRecord,
  prepareStateDir,
  updateSessionResumeId,
  writeSessionRecord,
} from "../../src/state/store.ts";
import * as claudeFakes from "../claude/helpers.ts";
import * as codexFakes from "../codex/helpers.ts";

/** A loop created at `createdAt`, so it expires `LOOP_EXPIRATION_MS` later. */
function loop(id: string, createdAt: number): PersistedLoopDefinition {
  const expiresAt = createdAt + LOOP_EXPIRATION_MS;
  const timing = { intervalMs: 60_000, jitterMs: 0, createdAt, expiresAt };
  return { id, message: "check", mode: "fixed", ...timing };
}

describe.each([
  { agent: "claude", fakes: claudeFakes, resume: resumeClaude },
  { agent: "codex", fakes: codexFakes, resume: resumeCodex },
] as const)("$agent", ({ agent, fakes, resume }) => {
  afterEach(fakes.resetFakes);

  /** A resumable session holding one expired and one live loop; returns its sidecar path. */
  function sessionWithLoops(cwd: string, id: string): string {
    const stateDir = join(cwd, ".elwood");
    prepareStateDir(stateDir, { cwd });
    const created = createSessionRecord({ cwd, id, adapter: agent });
    writeSessionRecord(
      updateSessionResumeId(created, agent, `${agent}-1`),
      safeSessionDir(stateDir, id),
    );
    const now = Date.now();
    writeLoopDefinitions(stateDir, id, [
      loop("expired", now - LOOP_EXPIRATION_MS - 1),
      loop("live", now),
    ]);
    return join(safeSessionDir(stateDir, id), "loops.json");
  }

  test(`C-API-20 C-LOOP-13 a failed ${agent} resume restores the loops it pruned`, async () => {
    const cwd = fakes.tempDir();
    const sidecar = sessionWithLoops(cwd, `${agent}-failed-resume`);
    const before = readFileSync(sidecar, "utf8");
    fakes.installFakes();
    setPtyFactoryForTests(() => {
      throw new Error("no PTY in this test");
    });
    await expect(resume({ cwd, elwoodSessionId: `${agent}-failed-resume` })).rejects.toMatchObject({
      code: "pty_start_failed",
    });
    expect(readFileSync(sidecar, "utf8")).toBe(before);
  });

  test(`C-LOOP-13 a ${agent} resume that starts keeps only its live loops`, async () => {
    const cwd = fakes.tempDir();
    const sidecar = sessionWithLoops(cwd, `${agent}-resumed`);
    fakes.installFakes();
    const session = await resume({ cwd, elwoodSessionId: `${agent}-resumed` });
    try {
      const { loops } = JSON.parse(readFileSync(sidecar, "utf8")) as { loops: { id: string }[] };
      expect(loops.map(({ id }) => id)).toEqual(["live"]);
    } finally {
      await session.teardown();
    }
  });
});
