/**
 * Conformance tests for session-less Codex model listing.
 * Covers PRD §5.7 and C-API-41.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { listCodexModels } from "../../src/index.ts";
import { setCommandRunnerForTests } from "../../src/runtime/seams.ts";
import { asScreen, codexPickerCurrentIsDefault, until } from "../helpers/model-pickers.ts";
import { installFakes, ptys, reapedGroups, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

/**
 * The probe creates its OWN temp state dir under the given parent, then a session
 * under a random UUID. Discover both so the fake can reach the session's bridge.
 */
function probeState(parent: string): { stateDir: string; id: string } {
  const [owned] = readdirSync(parent);
  const stateDir = join(parent, owned as string);
  const [id] = readdirSync(join(stateDir, "sessions"));
  return { stateDir, id: id as string };
}

/** Poll a condition without `expect` so it can live in a shared helper. */
/** Drive the fake probe through readiness, the rendered picker, and its close. */
async function driveProbe(cwd: string, parent: string): Promise<void> {
  await until(() => ptys.length === 1);
  const pty = ptys[0]!;
  const { stateDir, id } = probeState(parent);
  // Reach readiness via the SessionStart hook (C-API-28), using the probe's state dir.
  await pty.dispatchHook(
    id,
    {
      hook_event_name: "SessionStart",
      session_id: "codex-1",
      cwd,
      model: "gpt-5.3-codex",
      source: "startup",
    },
    stateDir,
  );
  await until(() => pty.writes.includes("/model") && pty.writes.includes("\r"));
  pty.emitData(asScreen(codexPickerCurrentIsDefault));
  await until(() => pty.writes.includes("\u001b"));
  pty.emitData(asScreen("› "));
}

describe("listCodexModels", () => {
  test("C-API-41 starts a throwaway session, lists models, and tears it down", async () => {
    const cwd = tempDir();
    const stateDir = join(cwd, "state");
    installFakes();
    // Pass every optional launch field so each is forwarded to startCodex.
    const listing = listCodexModels({
      cwd,
      stateDir,
      autoupdate: false,
      hookTimeoutMs: 5_000,
      strictVersionCheck: false,
      timeoutMs: 4_000,
    });
    await driveProbe(cwd, stateDir);
    const models = await listing;
    expect(models.map((model) => model.id)).toEqual([
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
    ]);
    expect(models[0]).toMatchObject({ isCurrent: true, isDefault: true });
    // The throwaway session was torn down: its PTY leader group was reaped.
    expect(reapedGroups).toContain(ptys[0]!.pid);
  });

  test("C-API-41 a start failure surfaces the adapter error with nothing to tear down", async () => {
    installFakes();
    setCommandRunnerForTests(() => ({
      status: null,
      stdout: "",
      stderr: "",
      error: { code: "ENOENT", message: "missing" },
    }));
    await expect(listCodexModels({ cwd: tempDir() })).rejects.toMatchObject({
      code: "codex_not_found",
    });
    expect(ptys).toHaveLength(0);
  });
});
