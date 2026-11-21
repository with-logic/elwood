/** Read the current quota of each CLI profile before starting a session (PRD §5.12, C-STATS-03). */

import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { optional } from "../optional.ts";
import { type UsageDeadline, usageDeadline, usageIsFresh } from "./freshness.ts";
import { probeQuota, type UsageProbeOptions } from "./probe.ts";
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

/** Check Claude then Codex by default. An explicit list replaces the defaults.
 * Each failed profile returns an unavailable reading in its original position. */
export function readAccountUsage(
  accounts?: readonly UsageAccount[],
): Promise<readonly AccountUsage[]> {
  return readUsageProfiles(accounts);
}

/**
 * Capture and validate an account roster synchronously, throwing `TypeError` for invalid input.
 * Calls to the returned reader share any pending read. Each account reading stays in memory
 * for up to five minutes from `checkedAt` or until an earlier reported reset.
 */
export function createAccountUsageReader(
  accounts?: readonly UsageAccount[],
): () => Promise<readonly AccountUsage[]> {
  const readers = captureProfiles(accounts).map(createCachedProfileReader);
  let pending: Promise<readonly AccountUsage[]> | undefined;
  return async () => {
    pending ??= Promise.all(readers.map((read) => read())).finally(() => {
      pending = undefined;
    });
    return structuredClone(await pending);
  };
}

function createCachedProfileReader(account: UsageAccount): () => Promise<AccountUsage> {
  let sample: { readonly reading: AccountUsage; readonly deadline: UsageDeadline } | undefined;
  return async () => {
    if (sample && usageIsFresh(sample.deadline)) return sample.reading;
    const reading = await readProfile(account);
    sample = { reading, deadline: usageDeadline(Date.parse(reading.checkedAt), reading.windows) };
    return reading;
  };
}

export async function readUsageProfiles(
  accounts?: readonly UsageAccount[],
  options?: UsageProbeOptions,
): Promise<readonly AccountUsage[]> {
  return await Promise.all(
    captureProfiles(accounts).map((profile) => readProfile(profile, options)),
  );
}

function captureProfiles(accounts: readonly UsageAccount[] = defaults): readonly UsageAccount[] {
  const profiles = accounts.map(({ agent, label, configDir }) => ({
    agent,
    label,
    ...optional(configDir, "configDir"),
  }));
  validateAccounts(profiles);
  return profiles;
}

async function readProfile(
  account: UsageAccount,
  options?: UsageProbeOptions,
): Promise<AccountUsage> {
  const { agent, label, configDir } = account;
  let windows: readonly UsageWindow[] = [];
  try {
    if (configDir === undefined || (await stat(configDir)).isDirectory()) {
      windows = await probeQuota(account, options);
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
