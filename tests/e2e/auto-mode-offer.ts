/**
 * Seeds and names Claude's auto-mode setup offer for the real-CLI tests of C-ATTN-09 and
 * C-CLI-05 (PRD §5.3, §12A.2).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../src/core/predicates.ts";
import { defaultClaudeConfigDir } from "./claude-home.ts";

export const offerTitle = "Teach auto mode about your environment?";

/**
 * Claude 2.1.332 offers setup after a turn in auto mode once it has started five times and
 * auto mode has denied five actions. It does not offer it once setup has saved an
 * environment, after "Don't show again" (`dismissed`), or within 7 days of an Esc
 * (`dismissedAt`); see `docs/cli-behavior.md`. Seed this process's private config, and
 * replace `autoModeEnvSetup` outright so that an earlier test's dismissal is cleared too.
 */
export function seedOffer(): void {
  const path = join(defaultClaudeConfigDir, ".claude.json");
  const config: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(config)) throw new Error(`${path} does not hold a JSON object`);
  const prior = config["numStartups"];
  const numStartups = Math.max(typeof prior === "number" ? prior : 0, 5);
  const seeded = { ...config, numStartups, autoModeEnvSetup: { denials: 5 } };
  writeFileSync(path, JSON.stringify(seeded), { mode: 0o600 });
}
