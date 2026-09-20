/** Shared successor ownership regression probes (C-API-20, C-LOOP-17). */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { type CodexSessionApi, resumeCodex, startCodex } from "../../src/index.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

test("C-LOOP-17 superseded cancellation cannot succeed while the successor retains the loop", async () => {
  installFakes();
  const cwd = tempDir();
  const prior = await startCodex({ cwd });
  let current: CodexSessionApi | undefined;
  try {
    await becomeReady(prior.elwoodSessionId, cwd);
    const loop = await prior.createLoop({ mode: "fixed", intervalMs: 60_000, message: "retained" });
    await prior.stop();
    current = await resumeCodex({ cwd, elwoodSessionId: prior.elwoodSessionId });
    await expect(prior.cancelLoop(loop.id)).rejects.toMatchObject({ code: "session_not_running" });
    await expect(
      prior.createLoop({ mode: "fixed", intervalMs: 60_000, message: "stale" }),
    ).rejects.toMatchObject({ code: "session_not_running" });
    expect(await current.listLoops()).toContainEqual(expect.objectContaining({ id: loop.id }));
  } finally {
    await current?.teardown();
    await prior.teardown();
  }
});

test.runIf(process.platform === "darwin")(
  "C-API-20 supported root-owned path aliases share teardown ownership",
  async () => {
    installFakes();
    const cwd = mkdtempSync("/private/tmp/elwood-successor-alias-");
    const stateDir = join(cwd, "state");
    const prior = await startCodex({ cwd, stateDir });
    let current: CodexSessionApi | undefined;
    try {
      await ptys[0]!.dispatchHook(
        prior.elwoodSessionId,
        {
          hook_event_name: "SessionStart",
          session_id: "resumable",
          cwd,
          source: "startup",
        },
        stateDir,
      );
      await prior.stop();
      current = await resumeCodex({
        cwd,
        stateDir: stateDir.replace("/private/tmp/", "/tmp/"),
        elwoodSessionId: prior.elwoodSessionId,
      });
      await prior.teardown();
      expect(existsSync(join(stateDir, "sessions", current.elwoodSessionId, "session.json"))).toBe(
        true,
      );
    } finally {
      await current?.teardown();
      await prior.teardown();
      rmSync(cwd, { recursive: true, force: true });
    }
  },
);
