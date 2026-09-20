/** CLI identity cleanup cannot erase live or pending same-process ownership (C-CLI-08/C-API-20). */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { HeadlessCliSession } from "../../src/cli/session/index.ts";
import { setCodexHookBridgeFactoryForTests } from "../../src/codex/session/bridge.ts";
import { startCodexWithId } from "../../src/codex/session/index.ts";
import { resumeCodex, startCodex } from "../../src/index.ts";
import { type CommandResult, setCommandRunnerForTests } from "../../src/runtime/seams.ts";
import { resetPreflightCacheForTests } from "../../src/runtime/update/once.ts";
import { installFakes, ptys, resetFakes, tempDir } from "../codex/helpers.ts";
import { effectiveRequest } from "./main-fakes.ts";

afterEach(resetFakes);

test("C-CLI-08 pending and failed facade teardown preserve the restored predecessor", async () => {
  installFakes();
  const cwd = tempDir();
  const stateDir = join(cwd, "state");
  const prior = await startCodex({ cwd, stateDir });
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
  const id = prior.elwoodSessionId;
  const record = join(stateDir, "sessions", id, "session.json");
  const probe = Promise.withResolvers<CommandResult>();
  resetPreflightCacheForTests();
  setCommandRunnerForTests(() => probe.promise);
  const facade = new HeadlessCliSession(
    effectiveRequest({ cwd, stateDir, agent: "codex", resume: id }),
    id,
    () => resumeCodex({ cwd, stateDir, elwoodSessionId: id }),
  );
  const starting = facade.start().catch((error: unknown) => error);
  try {
    await facade.teardown();
    expect(existsSync(record)).toBe(true);
    probe.resolve({ status: 0, stdout: "codex-cli 0.1.0", stderr: "" });
    expect(await starting).toMatchObject({ code: "codex_version_unsupported" });
    await facade.teardown();
    expect(existsSync(record)).toBe(true);
    await expect(
      ptys[0]!.dispatchHook(
        id,
        {
          hook_event_name: "SessionStart",
          session_id: "still-live",
          cwd,
          source: "startup",
        },
        stateDir,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
  } finally {
    probe.resolve({ status: 0, stdout: "codex-cli 0.1.0", stderr: "" });
    await starting;
    await prior.teardown();
  }
});

test("C-CLI-08 a fresh failed launch releases its claim for identity-only cleanup", async () => {
  installFakes();
  const cwd = tempDir();
  const stateDir = join(cwd, "state");
  const id = "failed-fresh";
  setCodexHookBridgeFactoryForTests(() => ({
    start: () => Promise.reject(new Error("bridge failed")),
    stop: () => Promise.resolve(),
  }));
  const facade = new HeadlessCliSession(
    effectiveRequest({ cwd, stateDir, agent: "codex" }),
    id,
    () => startCodexWithId({ cwd, stateDir }, id),
  );
  await expect(facade.start()).rejects.toMatchObject({ code: "hook_bridge_failed" });
  await facade.teardown();
  expect(existsSync(join(stateDir, "sessions", id))).toBe(false);
});
