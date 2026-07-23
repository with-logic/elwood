/**
 * Conformance tests for Codex session model switching and default restore.
 * Covers PRD §5.7 and C-CODEX-14.
 */

import { chmodSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "vitest";
import { startCodex } from "../../src/index.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";
import {
  becomeReadyFor,
  driveSetModel,
  driveUntilConfigWritten,
  restoreCodexHome,
  sandboxCodexHome,
  until,
  userConfig,
} from "./session-models-helpers.ts";

afterEach(() => {
  resetFakes();
  restoreCodexHome();
});

describe("CodexSession setModel", () => {
  test("C-CODEX-14 setModel restores the user's persisted default", async () => {
    const cwd = tempDir();
    const configPath = sandboxCodexHome(cwd);
    installFakes();
    const session = await startCodex({ cwd });
    await becomeReady(session.elwoodSessionId, cwd);
    await expect.poll(() => session.status).toBe("ready");
    const setting = session.setModel("gpt-5.4", { timeoutMs: 30_000 });
    await driveSetModel(
      configPath,
      'model = "gpt-5.4"\nmodel_reasoning_effort = "medium"\n\n[hooks]\n',
    );
    await setting;
    expect(readFileSync(configPath, "utf8")).toBe(userConfig);
    expect(session.warnings).toEqual([]);
  });

  test("C-CODEX-14 setModel warns instead of clobbering concurrent config edits", async () => {
    const cwd = tempDir();
    const configPath = sandboxCodexHome(cwd);
    installFakes();
    const session = await startCodex({ cwd });
    await becomeReady(session.elwoodSessionId, cwd);
    await expect.poll(() => session.status).toBe("ready");
    const setting = session.setModel("gpt-5.4", { timeoutMs: 30_000 });
    const concurrent = 'model = "gpt-5.4"\nextra = true\n\n[hooks]\n';
    await driveSetModel(configPath, concurrent);
    await setting;
    expect(readFileSync(configPath, "utf8")).toBe(concurrent);
    expect(session.warnings).toMatchObject([{ code: "codex_default_model_persisted" }]);
  });

  test("C-CODEX-14 restore runs even when picker automation rejects late", async () => {
    // Finding #3: Codex writes config.toml during confirmation, then the final
    // waitForScreen times out so super.setModel REJECTS. The finally-restore must
    // still run (user default restored) AND the primary error must propagate.
    const cwd = tempDir();
    const configPath = sandboxCodexHome(cwd);
    installFakes();
    const session = await startCodex({ cwd });
    await becomeReady(session.elwoodSessionId, cwd);
    await expect.poll(() => session.status).toBe("ready");
    const persisted = 'model = "gpt-5.4"\nmodel_reasoning_effort = "medium"\n\n[hooks]\n';
    // Long enough to reach the config write and the final confirmation wait, then
    // that wait times out because no "Model changed" screen ever arrives.
    const setting = session.setModel("gpt-5.4", { timeoutMs: 1_000 });
    await driveUntilConfigWritten(configPath, persisted);
    // The automation times out (no confirmation screen) and rejects.
    await expect(setting).rejects.toMatchObject({ code: "model_automation_failed" });
    // Restore still ran in the finally: the user's default is back on disk.
    expect(readFileSync(configPath, "utf8")).toBe(userConfig);
  });

  test("C-CODEX-14 both picker AND restore failing surfaces a bounded diagnostic", async () => {
    // The picker times out (primary error) AND the restore write fails (config.toml
    // made read-only): the primary error must still propagate, but the swallowed
    // restore failure must be REPORTED so the user learns config may stay mutated.
    const cwd = tempDir();
    const configPath = sandboxCodexHome(cwd);
    installFakes();
    const session = await startCodex({ cwd });
    await becomeReady(session.elwoodSessionId, cwd);
    await expect.poll(() => session.status).toBe("ready");
    const persisted = 'model = "gpt-5.4"\nmodel_reasoning_effort = "medium"\n\n[hooks]\n';
    const setting = session.setModel("gpt-5.4", { timeoutMs: 1_000 });
    await driveUntilConfigWritten(configPath, persisted);
    chmodSync(configPath, 0o400); // the restore write now throws EACCES
    try {
      await expect(setting).rejects.toMatchObject({ code: "model_automation_failed" });
      // The restore failure did not vanish: it is a bounded content-free warning.
      expect(session.warnings).toMatchObject([{ code: "codex_default_model_persisted" }]);
    } finally {
      chmodSync(configPath, 0o600);
    }
  });

  test("C-CODEX-14 two interleaving sessions cannot persist the wrong model", async () => {
    // Finding #2: a single process-global config.toml with two concurrent
    // setModel switches. The process-wide config lock serializes the whole
    // snapshot/picker/restore transaction so session B cannot snapshot A's
    // transiently-persisted model and restore it as the user's default.
    const cwd = tempDir();
    const configPath = sandboxCodexHome(cwd);
    installFakes();
    const [a, b] = await Promise.all([startCodex({ cwd }), startCodex({ cwd })]);
    await becomeReadyFor(a.elwoodSessionId, cwd, 0);
    await becomeReadyFor(b.elwoodSessionId, cwd, 1);
    await expect.poll(() => a.status === "ready" && b.status === "ready").toBe(true);

    const persisted = 'model = "gpt-5.4"\nmodel_reasoning_effort = "medium"\n\n[hooks]\n';
    const settingA = a.setModel("gpt-5.4", { timeoutMs: 30_000 });
    const settingB = b.setModel("gpt-5.4", { timeoutMs: 30_000 });
    // Only A holds the lock: B must NOT have written /model yet.
    await until(() => ptys[0]!.writes.includes("/model"));
    expect(ptys[1]!.writes.includes("/model")).toBe(false);
    await driveSetModel(configPath, persisted, 0);
    await settingA;
    // A released the lock and restored the user default before B started.
    expect(readFileSync(configPath, "utf8")).toBe(userConfig);
    await driveSetModel(configPath, persisted, 1);
    await settingB;
    // B snapshotted the RESTORED default (not A's transient model) and restored
    // it, so the final on-disk default is the user's original, not gpt-5.4.
    expect(readFileSync(configPath, "utf8")).toBe(userConfig);
    expect([...a.warnings, ...b.warnings]).toEqual([]);
  });
});
