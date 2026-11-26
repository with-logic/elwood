/**
 * A private Claude config dir that has not finished onboarding, so a real Claude starts on
 * its first-launch screens, and a host's raw-key answers to them (PRD §5.4, C-E2E-30).
 *
 * Claude 2.1.332's first launch draws, in order: a text-style picker, security notes, on
 * some terminals an offer to change the terminal's own settings, and the workspace trust
 * question. That offer edits the user's real terminal configuration when accepted, outside
 * any config dir, so the answers skip it with Esc (`claude-first-launch-answers.ts`) and
 * never press Enter on a screen they do not know. The terminal variables Claude detects it
 * by are unset as well.
 */

import { copyFileSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { ClaudeSessionApi } from "../../src/index.ts";
import { privateTempDir, removeOrReport } from "../helpers/private-temp.ts";
import { type FirstLaunchKey, firstLaunchKey } from "./claude-first-launch-answers.ts";
import { parseGlobalConfig } from "./claude-global-config.ts";
import { userConfigDir } from "./claude-home.ts";
import { registerPrivateHome } from "./home-guard.ts";
import { waitFor } from "./wait-for.ts";

/** The global-config keys that mark onboarding done; without them Claude onboards again. */
const onboardingKeys = ["hasCompletedOnboarding", "lastOnboardingVersion", "theme"];

/** Environment for the launch: the private config dir, and no terminal Claude could set up. */
export type FirstLaunch = {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Removes the config dir. Call it only once the session is confirmed stopped. */
  dispose(): void;
  /** Keeps the config dir, which a Claude still running may use, and fails the run with it. */
  keep(): void;
};

/**
 * Copies the suite's private config dir (`claude-home.ts`: the user's login without its
 * refresh token, and their global config) into a new one without the onboarding keys.
 */
export function firstLaunch(): FirstLaunch {
  const suite = process.env["CLAUDE_CONFIG_DIR"];
  if (suite === undefined) throw new Error("claude-home.ts did not set CLAUDE_CONFIG_DIR");
  const dir = privateTempDir("elwood_e2e_claude_first_launch-", userConfigDir, "Claude config dir");
  const release = registerPrivateHome(dir);
  const dispose = () => {
    release();
    removeOrReport(dir, "first-launch Claude config dir");
  };
  try {
    copyFileSync(join(suite, ".credentials.json"), join(dir, ".credentials.json"));
    const path = join(suite, ".claude.json");
    const global = parseGlobalConfig(readFileSync(path, "utf8"), path);
    for (const key of onboardingKeys) delete global[key];
    writeFileSync(join(dir, ".claude.json"), JSON.stringify(global), { mode: 0o600 });
  } catch (error) {
    dispose();
    throw error;
  }
  const terminalDetectionKeys = [
    "TERM_PROGRAM",
    "ALACRITTY_SOCKET",
    "ALACRITTY_WINDOW_ID",
    "ALACRITTY_LOG",
  ];
  const env = {
    CLAUDE_CONFIG_DIR: dir,
    ...Object.fromEntries(terminalDetectionKeys.map((key) => [key, undefined])),
  };
  const keep = () => {
    release();
    process.exitCode = 1;
    writeSync(
      2,
      `Kept the e2e first-launch Claude config dir ${JSON.stringify(dir)}: its Claude may still run\n`,
    );
  };
  return { env, dispose, keep };
}

const maxAnswers = 6;

/**
 * Answers the first-launch screens with raw keys until the session leaves `blocked`. A
 * screen it does not know fails the wait, unanswered. Returns the keys it pressed.
 */
export async function answerFirstLaunch(
  session: ClaudeSessionApi,
): Promise<readonly FirstLaunchKey[]> {
  const pressed: FirstLaunchKey[] = [];
  let answered: string | undefined;
  while (session.status === "blocked") {
    if (pressed.length >= maxAnswers) throw new Error(`Still blocked after ${maxAnswers} answers`);
    const next = await waitFor(() => {
      if (session.status !== "blocked") return null;
      const text = session.terminal.snapshot().text;
      if (text === answered) return undefined;
      return firstLaunchKey(text);
    }, "a first-launch screen to answer");
    if (next === null) break;
    answered = session.terminal.snapshot().text;
    await session.sendKeys(next);
    pressed.push(next);
  }
  return pressed;
}
