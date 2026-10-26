/**
 * Registers the e2e suite's private CLI homes with Elwood's CLI home guard (PRD §12,
 * C-E2E-24), in `ELWOOD_E2E_PRIVATE_HOMES`, which the Elwood processes this process starts
 * inherit. Each process starts its own list: a worker creates and registers its own homes.
 * Every login shell Elwood starts while Elwood's environment names a registered home checks,
 * after its startup files, that the home it exports is a registered one, and stops the launch
 * before the CLI starts otherwise. Each home that `codex-home.ts`, `claude-home.ts`,
 * `seedCodexHome`, or a native-proof sandbox creates is registered as soon as it exists.
 */

import { realpathSync } from "node:fs";
import { isStringArray } from "../../src/core/predicates.ts";
import { homeGuardHomesKey } from "../../src/runtime/shell.ts";

// A list this process inherited is not the suite's: it could name any directory, the user's
// own CLI homes included. Each process lists only the homes it creates, and the processes it
// starts inherit those.
delete process.env[homeGuardHomesKey];

/** The homes this process has registered so far. */
function registeredHomes(): readonly string[] {
  const raw = process.env[homeGuardHomesKey];
  if (raw === undefined || raw === "") return [];
  const parsed: unknown = JSON.parse(raw);
  if (!isStringArray(parsed)) throw new Error(`${homeGuardHomesKey} is not a JSON array of paths`);
  return parsed;
}

/**
 * Registers the existing directory `home`, in the spelling Elwood's environment will name it
 * by and in its real one, which the guard compares the exported home's real path against.
 * Returns what restores the registry as it was, for a sandbox that leaves the environment as
 * it found it.
 */
export function registerPrivateHome(home: string): () => void {
  const before = process.env[homeGuardHomesKey];
  const homes = new Set([...registeredHomes(), home, realpathSync(home)]);
  process.env[homeGuardHomesKey] = JSON.stringify([...homes]);
  return () => {
    if (before === undefined) delete process.env[homeGuardHomesKey];
    else process.env[homeGuardHomesKey] = before;
  };
}
