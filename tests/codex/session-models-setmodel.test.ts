/**
 * Conformance tests for Codex session model switching and default restore.
 * Covers PRD §5.7 and C-CODEX-14.
 */

import { mkdirSync, readFileSync, rmSync } from "node:fs";
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

describe("CodexSessionApi setModel", () => {
  test("C-CODEX-14 setModel restores the user's persisted default", async () => {
    const cwd = tempDir();
    const configPath = sandboxCodexHome(cwd);
    installFakes();
    const session = await startCodex({ cwd });
    const warnings = collectWarnings(session);
    await becomeReady(session.elwoodSessionId, cwd);
    await expect.poll(() => session.status).toBe("ready");
    const setting = session.setModel("gpt-5.4", { timeoutMs: 30_000 });
    await driveSetModel(
      configPath,
      'model = "gpt-5.4"\nmodel_reasoning_effort = "medium"\n\n[hooks]\n',
    );
    await setting;
    expect(readFileSync(configPath, "utf8")).toBe(userConfig);
    expect(warnings).toEqual([]);
  });

  test("C-CODEX-14 setModel warns instead of clobbering concurrent config edits", async () => {
    const cwd = tempDir();
    const configPath = sandboxCodexHome(cwd);
    installFakes();
    const session = await startCodex({ cwd });
    const warnings = collectWarnings(session);
    await becomeReady(session.elwoodSessionId, cwd);
    await expect.poll(() => session.status).toBe("ready");
    const setting = session.setModel("gpt-5.4", { timeoutMs: 30_000 });
    const concurrent = 'model = "gpt-5.4"\nextra = true\n\n[hooks]\n';
    await driveSetModel(configPath, concurrent);
    await setting;
    expect(readFileSync(configPath, "utf8")).toBe(concurrent);
    expect(warnings).toMatchObject([{ code: "codex_default_model_persisted" }]);
  });

  test("C-CODEX-14 restore runs even when picker automation rejects late", async () => {
    // Codex writes config.toml during confirmation, then the final waitForScreen
    // times out so super.setModel REJECTS. The finally-restore must
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
    // The picker times out (primary error) AND the restore fails (config.toml is
    // replaced by a directory, which fails for every uid — a read-only file would
    // not stop root): the primary error must still propagate, but the swallowed
    // restore failure must be REPORTED so the user learns config may stay mutated.
    const cwd = tempDir();
    const configPath = sandboxCodexHome(cwd);
    installFakes();
    const session = await startCodex({ cwd });
    const warnings = collectWarnings(session);
    await becomeReady(session.elwoodSessionId, cwd);
    await expect.poll(() => session.status).toBe("ready");
    const persisted = 'model = "gpt-5.4"\nmodel_reasoning_effort = "medium"\n\n[hooks]\n';
    const setting = session.setModel("gpt-5.4", { timeoutMs: 1_000 });
    await driveUntilConfigWritten(configPath, persisted);
    rmSync(configPath);
    mkdirSync(configPath); // the restore's read now throws EISDIR
    await expect(setting).rejects.toMatchObject({ code: "model_automation_failed" });
    // The restore failure did not vanish: it is a bounded content-free warning.
    expect(warnings).toMatchObject([{ code: "codex_default_model_persisted" }]);
    // Content-free: `raw` carries only the config path and a bounded errno code,
    // never a raw error message (which could leak credentials/conversation data).
    expect(warnings[0]?.raw).toMatch(/config\.toml \(EISDIR\)$/);
  });

  test("C-CODEX-14 a config.toml the picker CREATED is left in place with an accurate warning", async () => {
    // No config.toml existed before the switch, so there is no snapshot to restore:
    // the new file is left alone and the warning says so, rather than claiming the
    // file "changed in other ways".
    const cwd = tempDir();
    const configPath = sandboxCodexHome(cwd);
    rmSync(configPath);
    installFakes();
    const session = await startCodex({ cwd });
    const warnings = collectWarnings(session);
    await becomeReady(session.elwoodSessionId, cwd);
    await expect.poll(() => session.status).toBe("ready");
    const setting = session.setModel("gpt-5.4", { timeoutMs: 30_000 });
    const created = 'model = "gpt-5.4"\nmodel_reasoning_effort = "medium"\n';
    await driveSetModel(configPath, created);
    await setting;
    expect(readFileSync(configPath, "utf8")).toBe(created);
    expect(warnings).toMatchObject([
      {
        code: "codex_default_model_persisted",
        message: expect.stringContaining("did not exist before the switch"),
        raw: configPath,
      },
    ]);
  });

  test("C-CODEX-14 two interleaving sessions cannot persist the wrong model", async () => {
    // A single process-global config.toml with two concurrent setModel switches. The process-wide config lock serializes the whole
    // snapshot/picker/restore transaction so session B cannot snapshot A's
    // transiently-persisted model and restore it as the user's default.
    const cwd = tempDir();
    const configPath = sandboxCodexHome(cwd);
    installFakes();
    const [a, b] = await Promise.all([startCodex({ cwd }), startCodex({ cwd })]);
    const warningsA = collectWarnings(a);
    const warningsB = collectWarnings(b);
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
    expect([...warningsA, ...warningsB]).toEqual([]);
  });
});

/** Collect live `warning` events (warnings are emit-only, never persisted). */
type SeenWarning = { code: string; message?: string; raw?: string };
function collectWarnings(session: {
  on: (event: "warning", handler: (event: SeenWarning) => void) => unknown;
}): SeenWarning[] {
  const warnings: SeenWarning[] = [];
  session.on("warning", (event) => warnings.push(event));
  return warnings;
}
