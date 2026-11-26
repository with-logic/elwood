/**
 * Seeds, starts and waits for Claude's auto-mode setup offer for the real-CLI tests of
 * C-ATTN-09, C-ATTN-10 and C-CLI-05 (PRD §5.3, §12A.2).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeScreenFactTable } from "../../src/claude/screen-table.ts";
import { isRecord } from "../../src/core/predicates.ts";
import { readScreenFacts } from "../../src/core/screen-facts.ts";
import type { ClaudeSessionApi, StartClaudeOptions } from "../../src/index.ts";
import { defaultClaudeConfigDir } from "./claude-home.ts";
import type { E2eProject } from "./scratch.ts";
import { waitFor } from "./wait-for.ts";

export const offerTitle = "Teach auto mode about your environment?";

/**
 * Claude 2.1.332 offers setup after a turn in auto mode once it has started five times and
 * auto mode has denied five actions. It does not offer it once setup has saved an
 * environment, after "Don't show again" (`dismissed`), or within 7 days of an Esc
 * (`dismissedAt`); see `docs/cli-behavior.md`. Seed this process's private config, and
 * replace `autoModeEnvSetup` outright so that an earlier test's dismissal is cleared too.
 */
export function seedOffer(): void {
  const path = configPath();
  const config = readConfig();
  const prior = config["numStartups"];
  const numStartups = Math.max(typeof prior === "number" ? prior : 0, 5);
  const seeded = { ...config, numStartups, autoModeEnvSetup: { denials: 5 } };
  writeFileSync(path, JSON.stringify(seeded), { mode: 0o600 });
}

const configPath = () => join(defaultClaudeConfigDir, ".claude.json");

function readConfig(): Record<string, unknown> {
  const config: unknown = JSON.parse(readFileSync(configPath(), "utf8"));
  if (!isRecord(config)) throw new Error(`${configPath()} does not hold a JSON object`);
  return config;
}

/** This process's `autoModeEnvSetup`: Esc on the offer stamps `dismissedAt`, Yes removes it. */
export function offerSetupState(): Record<string, unknown> | undefined {
  const state = readConfig()["autoModeEnvSetup"];
  return isRecord(state) ? state : undefined;
}

/** The named auto-mode session every offer test starts, so that each can see the offer. */
export function offerSessionOptions(project: E2eProject, name: string): StartClaudeOptions {
  return {
    cwd: project.cwd,
    stateDir: project.stateDir,
    autotrust: true,
    autoupdate: false,
    name,
    model: "haiku",
    permissionMode: "auto",
    initialSize: { cols: 140, rows: 40 },
  };
}

const offerLabel = "offer";

/**
 * Whether the offer painted in time. Only a timeout that leaves a `ready` session on an idle
 * composer reads as "Claude did not offer it"; an exited session, a failed render, another
 * dialog, a turn still working or any other error fails.
 */
export async function offerShown(session: ClaudeSessionApi, timeoutMs = 15_000): Promise<boolean> {
  const screen = () => session.terminal.snapshot().text;
  try {
    await waitFor(() => (screen().includes(offerTitle) ? true : undefined), offerLabel, timeoutMs);
    return true;
  } catch (error) {
    if (!(error instanceof Error && error.message === `Timed out waiting for ${offerLabel}`))
      throw error;
    if (session.status === "exited") throw new Error(`Claude exited instead:\n${screen()}`);
    if (session.terminal.renderFailed) throw new Error("The terminal stopped rendering.");
    const frame = { text: screen(), title: session.terminal.title };
    const { facts } = readScreenFacts(claudeScreenFactTable, frame);
    const idle = facts.composer_visible && !facts.working_visible && !facts.blocking_prompt_visible;
    if (session.status !== "ready" || !idle)
      throw new Error(`No offer, and no idle composer either (${session.status}):\n${frame.text}`);
    return false;
  }
}
