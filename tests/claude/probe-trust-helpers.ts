/**
 * Drives `listClaudeModels` on a fake Claude to a trust prompt and reports how the probe ended,
 * for the probe's trust policy tests (PRD §5.3, C-CLAUDE-26, C-CLAUDE-27).
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import type { ProbeRefusalCategory } from "../../src/claude/list-models.ts";
import { listClaudeModels } from "../../src/index.ts";
import { type CommandRunner, setCommandRunnerForTests } from "../../src/runtime/seams.ts";
import {
  resetAutoupdateForTests,
  setUpdateCoordinatorForTests,
} from "../../src/runtime/update/once.ts";
import { asScreen, until } from "../helpers/model-pickers.ts";
import { installFakes, ptys, reapedGroups, tempDir } from "./helpers.ts";

/** A fake Claude that reports `version`. */
export const reporting =
  (version: string): CommandRunner =>
  () => ({ status: 0, stdout: `${version}\n`, stderr: "" });

/** How a probe is started: with an update first, and what runs once its PTY spawns. */
type ProbeStart = { readonly autoupdate?: boolean; readonly beforeShow?: () => void };

/** Starts the probe on a fake Claude, `version` or a runner, and shows it `screen(cwd)`. */
export async function probeShown(
  version: string | CommandRunner,
  screen: (cwd: string) => string,
  { autoupdate = false, beforeShow }: ProbeStart = {},
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
  beforeShow?.();
  pty.emitData(asScreen(screen(cwd)));
  return { listing, pty, stateDir };
}

export type ProbeShown = Awaited<ReturnType<typeof probeShown>>;

/** How the probe ended: its rejection, what it wrote, and what it left running or on disk. */
export async function probeEnd({ listing, pty, stateDir }: ProbeShown) {
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

/** Rejected with `category` and `reason`, nothing answered, and nothing left behind. */
export const refused = (reason: RegExp, category: ProbeRefusalCategory = "workspace_hooks") => ({
  error: expect.objectContaining({
    code: "claude_start_failed",
    message: expect.stringMatching(reason),
    details: { category },
  }),
  writes: [],
  reaped: true,
  state: [],
});
