/** Read the current quota of each CLI profile before starting a session (PRD §5.12, C-STATS-03). */
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { claudeWindows } from "./claude.ts";
import { codexWindows } from "./codex.ts";
import { probeQuota } from "./probe.ts";
import type { AccountUsage, UsageAccount, UsageWindow } from "./types.ts";

const defaults = [
  { agent: "claude", label: "Claude" },
  { agent: "codex", label: "Codex" },
] as const;

export function validateAccounts(accounts: readonly UsageAccount[]): void {
  const names = new Set<string>();
  for (const { agent, label, configDir } of accounts) {
    if (agent !== "claude" && agent !== "codex")
      throw new TypeError("Expected a Claude or Codex profile.");
    if (!label.trim()) throw new TypeError("Account label must be nonblank.");
    if (configDir !== undefined && !isAbsolute(configDir))
      throw new TypeError("Profile directory must be absolute.");
    const key = JSON.stringify([agent, label]);
    if (names.has(key))
      throw new TypeError("Each account needs a distinct label for its provider.");
    names.add(key);
  }
}

export async function readAccountUsage(
  accounts: readonly UsageAccount[] = defaults,
): Promise<readonly AccountUsage[]> {
  validateAccounts(accounts);
  return await Promise.all(accounts.map(readProfile));
}

async function readProfile(profile: UsageAccount): Promise<AccountUsage> {
  const account = { ...profile };
  const { agent, label, configDir } = account;
  let windows: UsageWindow[] = [];
  try {
    if (configDir === undefined || (await stat(configDir)).isDirectory()) {
      const reply = await probeQuota(account);
      windows = agent === "claude" ? claudeWindows(reply) : codexWindows(reply);
    }
  } catch {
    // A missing profile, unavailable CLI or unsupported protocol affects only its own row.
  }
  return {
    agent,
    label,
    checkedAt: new Date().toISOString(),
    status: windows.length ? "available" : "unavailable",
    windows,
  };
}
