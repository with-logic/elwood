/**
 * Conformance tests for session-less Claude model listing.
 * Covers PRD §5.3 and C-API-41.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { listClaudeModels } from "../../src/index.ts";
import { setCommandRunnerForTests } from "../../src/runtime/seams.ts";
import { asScreen, claudePicker } from "../helpers/model-pickers.ts";
import { installFakes, ptys, reapedGroups, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

const instructionsLoaded = (cwd: string) => ({
  hook_event_name: "InstructionsLoaded",
  session_id: "claude-1",
  cwd,
  file_path: "/tmp/CLAUDE.md",
  memory_type: "Project",
  load_reason: "session_start",
});

/** The probe's session id is a random UUID; discover it from its state dir. */
function probeSessionId(stateDir: string): string {
  const [id] = readdirSync(join(stateDir, "sessions"));
  return id as string;
}

/** Poll a condition without `expect` so it can live in a shared helper. */
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("probe flow condition not reached");
}

/** Drive the fake probe through readiness, the rendered picker, and its close. */
async function driveProbe(cwd: string, stateDir: string): Promise<void> {
  // The probe's PTY exists only once startClaude resolves inside listClaudeModels.
  await until(() => ptys.length === 1);
  const pty = ptys[0]!;
  // Reach readiness so the probe leaves `waitForStatus(ready)`.
  await pty.dispatchHook(probeSessionId(stateDir), instructionsLoaded(cwd), stateDir);
  // listModels opens the picker; feed the rendered rows, then the closed screen.
  await until(() => pty.writes.includes("/model"));
  pty.emitData(asScreen(claudePicker));
  await until(() => pty.writes.includes("\u001b"));
  pty.emitData(asScreen("❯ "));
}

describe("listClaudeModels", () => {
  test("C-API-41 starts a throwaway session, lists models, and tears it down", async () => {
    const cwd = tempDir();
    const stateDir = join(cwd, "state");
    installFakes();
    // Pass every optional launch field so each is forwarded to startClaude.
    const listing = listClaudeModels({
      cwd,
      stateDir,
      autoupdate: false,
      hookTimeoutMs: 5_000,
      strictVersionCheck: false,
      timeoutMs: 4_000,
    });
    await driveProbe(cwd, stateDir);
    const models = await listing;
    // Exactly the listModels rows for the rendered picker.
    expect(models.map((model) => model.id)).toEqual([
      "default",
      "opus",
      "fable",
      "sonnet",
      "haiku",
    ]);
    expect(models.find((model) => model.isCurrent)?.id).toBe("fable");
    expect(models.find((model) => model.isDefault)?.id).toBe("default");
    // The throwaway session was torn down: its PTY leader group was reaped.
    expect(reapedGroups).toContain(ptys[0]!.pid);
  });

  test("C-API-41 a start failure surfaces the adapter error with nothing to tear down", async () => {
    installFakes();
    // The `claude` binary cannot be spawned: startClaude fails BEFORE any session
    // (and thus any PTY or teardown) exists, so the typed error surfaces as-is.
    setCommandRunnerForTests(() => ({
      status: null,
      stdout: "",
      stderr: "",
      error: { code: "ENOENT", message: "missing" },
    }));
    await expect(listClaudeModels({ cwd: tempDir() })).rejects.toMatchObject({
      code: "claude_not_found",
    });
    expect(ptys).toHaveLength(0);
  });
});
