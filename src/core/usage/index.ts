/** Read the current quota of each CLI profile before starting a session (PRD §5.12, C-STATS-03). */

import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { claudeWindows } from "../../claude/usage/windows.ts";
import { codexWindows } from "../../codex/usage/windows.ts";
import { optional } from "../optional.ts";
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

export function readAccountUsage(
  accounts?: readonly UsageAccount[],
): Promise<readonly AccountUsage[]> {
  return readUsageProfiles(accounts);
}

export async function readUsageProfiles(
  accounts: readonly UsageAccount[] = defaults,
  signal?: AbortSignal,
): Promise<readonly AccountUsage[]> {
  const profiles = accounts.map(({ agent, label, configDir }) => ({
    agent,
    label,
    ...optional(configDir, "configDir"),
  }));
  validateAccounts(profiles);
  return await Promise.all(profiles.map((profile) => readProfile(profile, signal)));
}

async function readProfile(account: UsageAccount, signal?: AbortSignal): Promise<AccountUsage> {
  const { agent, label, configDir } = account;
  let windows: UsageWindow[] = [];
  try {
    if (configDir === undefined || (await stat(configDir)).isDirectory()) {
      const reply = await probeQuota(account, signal);
      windows = agent === "claude" ? claudeWindows(reply) : codexWindows(reply);
    }
  } catch {
    // A missing profile, unavailable CLI or unsupported protocol affects only its own row.
  }
  const sample = { agent, label, checkedAt: new Date().toISOString() };
  const [first, ...rest] = windows;
  return first === undefined
    ? { ...sample, status: "unavailable", windows: [] }
    : { ...sample, status: "available", windows: [first, ...rest] };
}
