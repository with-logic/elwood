/** Loop activation failure cannot leak a fully built session runtime (C-API-20). */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { resumeClaude, resumeCodex, startClaude, startCodex } from "../../src/index.ts";
import { currentPtyFactory, setPtyFactoryForTests } from "../../src/runtime/seams.ts";
import { setGroupKillerForTests } from "../../src/runtime/shutdown/reap-tree.ts";
import { writePrivateFileAtomic } from "../../src/state/files.ts";
import * as claude from "../claude/helpers.ts";
import * as codex from "../codex/helpers.ts";
import { launchArtifactPaths } from "../helpers/launch-artifacts.ts";

afterEach(() => {
  claude.resetFakes();
  codex.resetFakes();
});

for (const adapter of [
  { name: "claude", start: startClaude, resume: resumeClaude, helpers: claude },
  { name: "codex", start: startCodex, resume: resumeCodex, helpers: codex },
] as const) {
  test.each([
    false,
    true,
  ])(`C-API-20 ${adapter.name} activation failure cleans its launch (reap failure: %s)`, async (reapFails) => {
    adapter.helpers.installFakes();
    const cwd = adapter.helpers.tempDir();
    const prior = await adapter.start({ cwd });
    try {
      await adapter.helpers.ptys[0]!.dispatchHook(prior.elwoodSessionId, {
        hook_event_name: "SessionStart",
        session_id: "prior",
        cwd,
        source: "startup",
      });
      const dir = join(cwd, ".elwood", "sessions", prior.elwoodSessionId);
      const factory = currentPtyFactory();
      let successorSocket = "";
      setPtyFactoryForTests((options) => {
        const pty = factory(options);
        successorSocket = adapter.helpers.readBridgeScript(
          launchArtifactPaths(options, dir).bridge,
        ).socketPath;
        // The initial durable read already passed; only commit sees this corruption.
        writePrivateFileAtomic(join(dir, "loops.json"), "not-json");
        if (reapFails)
          setGroupKillerForTests({
            killGroup: () => {
              throw new Error("reap denied");
            },
          });
        return pty;
      });
      await expect(
        adapter.resume({ cwd, elwoodSessionId: prior.elwoodSessionId }),
      ).rejects.toMatchObject({ code: "state_corrupt" });
      expect(adapter.helpers.ptys[1]!.killSignals).toEqual(["SIGTERM"]);
      expect(adapter.helpers.ptys[0]!.killSignals).toEqual([]);
      expect(successorSocket).not.toBe("");
      expect(existsSync(successorSocket)).toBe(false);
      await expect(
        adapter.helpers.ptys[0]!.dispatchHook(prior.elwoodSessionId, {
          hook_event_name: "SessionStart",
          session_id: "prior",
          cwd,
          source: "startup",
        }),
      ).resolves.toMatchObject({ exitCode: 0 });
    } finally {
      setGroupKillerForTests({ killGroup: () => undefined });
      adapter.helpers.ptys[1]?.emitExit({ exitCode: 0 });
      await prior.teardown();
    }
  });
}
