/**
 * The model probe's workspace trust policy (PRD §5.3, C-CLAUDE-26): on a Claude that discloses
 * hooks, it answers a plain workspace prompt and refuses one that discloses hooks; on an older
 * Claude, or one whose version is unparseable, it refuses every workspace prompt. A refusal
 * writes nothing, so the folder stays untrusted, and tears the probe down.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { claudeHooksDisclosureVersion } from "../../src/claude/preflight.ts";
import { listClaudeModels } from "../../src/index.ts";
import { setCommandRunnerForTests } from "../../src/runtime/seams.ts";
import { claudeWorkspaceTrustScreen } from "../helpers/claude-workspace-trust-screen.ts";
import { asScreen, until } from "../helpers/model-pickers.ts";
import { installFakes, ptys, reapedGroups, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

/** Starts the probe on a fake Claude reporting `version`, and shows it `prompt`'s variant. */
async function probeShown(version: string, prompt: "plain" | "hooks") {
  const cwd = tempDir();
  const stateDir = join(cwd, "state");
  installFakes();
  setCommandRunnerForTests(() => ({ status: 0, stdout: `${version}\n`, stderr: "" }));
  const listing = listClaudeModels({ cwd, stateDir });
  await until(() => ptys.length === 1);
  const pty = ptys[0]!;
  pty.emitData(asScreen(claudeWorkspaceTrustScreen(cwd, "no", prompt)));
  return { listing, pty, stateDir };
}

/** How the probe ended: its rejection, what it wrote, and what it left running or on disk. */
async function probeEnd({ listing, pty, stateDir }: Awaited<ReturnType<typeof probeShown>>) {
  const error = await listing.then(
    () => undefined,
    (rejection: unknown) => rejection,
  );
  return {
    error,
    writes: pty.writes,
    reaped: reapedGroups.includes(pty.pid),
    state: readdirSync(stateDir),
  };
}

/** Rejected with `reason`, nothing answered, and no process or state left behind. */
const refused = (reason: RegExp) => ({
  error: expect.objectContaining({
    code: "claude_start_failed",
    message: expect.stringMatching(reason),
    details: { category: "workspace_hooks" },
  }),
  writes: [],
  reaped: true,
  state: [],
});

test("C-CLAUDE-26 the probe refuses a prompt that discloses hooks", async () => {
  const end = await probeEnd(await probeShown(claudeHooksDisclosureVersion, "hooks"));
  expect(end).toEqual(refused(/says this folder has hooks/));
});

test.each([
  ["older", "2.1.144"],
  ["unparseable", "Claude Code (dev build)"],
])("C-CLAUDE-26 the probe refuses a plain prompt from a Claude whose version is %s", async (_, version) => {
  const end = await probeEnd(await probeShown(version, "plain"));
  expect(end).toEqual(refused(/cannot say whether this folder has hooks/));
});

test("C-CLAUDE-26 the probe answers a plain prompt from a Claude that discloses hooks", async () => {
  const { listing, pty } = await probeShown(claudeHooksDisclosureVersion, "plain");
  await until(() => pty.writes.length > 0);
  // Autotrust began its answer: Home, then Down to "Yes, I trust this folder".
  expect(pty.writes[0]).toBe("\u001b[H\u001b[B");
  // The listing then waits for readiness; ending the probe here is enough.
  pty.emitExit({ exitCode: 0 });
  await expect(listing).rejects.not.toMatchObject({ details: { category: "workspace_hooks" } });
});
