/**
 * The model probe's workspace trust policy (PRD §5.3, C-CLAUDE-26): on a Claude that discloses
 * hooks, 2.1.329 and later, it answers a plain workspace prompt and refuses one that discloses
 * hooks; on an older Claude, or one whose version is unparseable, it refuses every workspace
 * prompt. The version is the one Claude runs after any update. A refusal writes nothing, so the
 * folder stays untrusted, and tears the probe down.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { claudeHooksDisclosureVersion } from "../../src/claude/preflight.ts";
import { ElwoodError, listClaudeModels } from "../../src/index.ts";
import { type CommandRunner, setCommandRunnerForTests } from "../../src/runtime/seams.ts";
import {
  resetAutoupdateForTests,
  setUpdateCoordinatorForTests,
} from "../../src/runtime/update/once.ts";
import { claudeWorkspaceTrustScreen } from "../helpers/claude-workspace-trust-screen.ts";
import { asScreen, until } from "../helpers/model-pickers.ts";
import { installFakes, ptys, reapedGroups, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

/** A fake Claude that reports `version`. */
const reporting =
  (version: string): CommandRunner =>
  () => ({ status: 0, stdout: `${version}\n`, stderr: "" });

/** Starts the probe on a fake Claude, `version` or a runner, and shows it `prompt`'s variant. */
async function probeShown(
  version: string | CommandRunner,
  prompt: "plain" | "hooks",
  autoupdate = false,
) {
  const cwd = tempDir();
  const stateDir = join(cwd, "state");
  installFakes();
  if (autoupdate) {
    resetAutoupdateForTests();
    // In process: a unit test never takes the host's real update lease.
    setUpdateCoordinatorForTests((_adapter, update) => update());
  }
  setCommandRunnerForTests(typeof version === "string" ? reporting(version) : version);
  const listing = listClaudeModels({ cwd, stateDir, autoupdate });
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

/** The probe's first write, then whether it ended in the hooks refusal once the PTY exits. */
async function answered({ listing, pty }: Awaited<ReturnType<typeof probeShown>>) {
  await until(() => pty.writes.length > 0);
  const first = pty.writes[0];
  // The listing then waits for readiness; ending the probe here is enough.
  pty.emitExit({ exitCode: 0 });
  const refused = await listing.then(
    () => false,
    (error: unknown) =>
      error instanceof ElwoodError && error.details?.["category"] === "workspace_hooks",
  );
  return { first, refused };
}

/** Autotrust began its answer (Home, then Down to "Yes, I trust this folder"), unrefused. */
const answeredOutcome = { first: "\u001b[H\u001b[B", refused: false };

test("C-CLAUDE-26 Claude 2.1.329 is the first version the probe trusts to disclose hooks", () => {
  expect(claudeHooksDisclosureVersion).toBe("2.1.329");
});

test("C-CLAUDE-26 the probe refuses a prompt that discloses hooks", async () => {
  const end = await probeEnd(await probeShown("2.1.329", "hooks"));
  expect(end).toEqual(refused(/says this folder has hooks/));
});

test.each([
  ["older", "2.1.144"],
  ["the last that cannot disclose hooks", "2.1.328"],
  ["unparseable", "Claude Code (dev build)"],
])("C-CLAUDE-26 the probe refuses a plain prompt from a Claude whose version is %s", async (_, version) => {
  const end = await probeEnd(await probeShown(version, "plain"));
  expect(end).toEqual(refused(/cannot say whether this folder has hooks/));
});

test("C-CLAUDE-26 the probe answers a plain prompt from a Claude that discloses hooks", async () => {
  expect(await answered(await probeShown("2.1.329", "plain"))).toEqual(answeredOutcome);
});

test("C-CLAUDE-26 the probe judges a plain prompt by the version Claude updated to", async () => {
  let updated = false;
  const updating: CommandRunner = (_command, args) => {
    if (args.join(" ").includes("claude update")) updated = true;
    return reporting(updated ? "2.1.329" : "2.1.328")(_command, args, {});
  };
  const shown = await probeShown(updating, "plain", true);
  expect(updated).toBe(true);
  expect(await answered(shown)).toEqual(answeredOutcome);
});
