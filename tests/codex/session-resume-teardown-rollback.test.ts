/** Failed resume restores cleanup after an older teardown was held back (C-API-20). */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { resumeCodex, startCodex } from "../../src/index.ts";
import { type CommandResult, setCommandRunnerForTests } from "../../src/runtime/seams.ts";
import { resetPreflightCacheForTests } from "../../src/runtime/update/once.ts";
import { readLoopDefinitions } from "../../src/state/loop-store.ts";
import { becomeReady, installFakes, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

test("C-API-20 teardown joins pending resume and completes shared cleanup on rollback", async () => {
  installFakes();
  const cwd = tempDir();
  const session = await startCodex({ cwd });
  await becomeReady(session.elwoodSessionId, cwd);
  const loop = await session.createLoop({ mode: "fixed", intervalMs: 60_000, message: "retained" });
  const probe = Promise.withResolvers<CommandResult>();
  resetPreflightCacheForTests();
  setCommandRunnerForTests(() => probe.promise);
  const resuming = resumeCodex({ cwd, elwoodSessionId: session.elwoodSessionId }).catch(
    (error: unknown) => error,
  );
  const stateDir = join(cwd, ".elwood");
  const dir = join(stateDir, "sessions", session.elwoodSessionId);
  try {
    const tearingDown = session.teardown();
    expect(existsSync(join(dir, "session.json"))).toBe(true);
    expect(readLoopDefinitions(stateDir, session.elwoodSessionId)).toContainEqual(
      expect.objectContaining({ id: loop.id }),
    );
    probe.resolve({ status: 0, stdout: "codex-cli 0.1.0\n", stderr: "" });
    expect(await resuming).toMatchObject({ code: "codex_version_unsupported" });
    await tearingDown;
    expect(existsSync(dir)).toBe(false);
  } finally {
    probe.resolve({ status: 0, stdout: "codex-cli 0.1.0\n", stderr: "" });
    await resuming;
    await session.teardown();
  }
});
