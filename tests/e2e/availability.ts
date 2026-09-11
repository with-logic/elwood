/**
 * Decides whether a real-agent e2e test can run on this host (PRD §12, C-E2E-04):
 * probes each CLI through the SAME login shell resolution the product uses
 * (`userShell()` + `command -v`, see `src/cli/request/agent-detect.ts`), memoized per agent,
 * and folds every skip condition through one helper so a second condition is never
 * silently discarded. `ELWOOD_E2E_REQUIRE=1` turns any skip into a failure so a CI
 * host missing a CLI cannot exit green with nothing exercised.
 */

import { spawnSync } from "node:child_process";
import type { TestContext } from "node:test";
import { probeShellCommand, userShell } from "../../src/runtime/shell.ts";

export type AgentName = "claude" | "codex";

export const e2eTimeoutMs = Number(process.env["ELWOOD_E2E_TIMEOUT_MS"] ?? 180_000);
export const turnsEnabled = process.env["ELWOOD_E2E_SKIP_TURNS"] !== "1";
/** Skip reason for tests that run a real model turn; `undefined` when turns are on. */
export const skipTurns = turnsEnabled ? undefined : "ELWOOD_E2E_SKIP_TURNS=1 disables turn flows";
/** With `ELWOOD_E2E_REQUIRE=1` a would-be skip is a failure (CI must exercise the CLIs). */
export const requireAll = process.env["ELWOOD_E2E_REQUIRE"] === "1";

const probed = new Map<AgentName, string | undefined>();

/**
 * Why `agent` cannot be exercised here, or `undefined` when it can. The probe runs
 * once per agent per process (each `test()` registration used to spawn a fresh
 * interactive login shell) and uses the user's own shell rather than a hard-coded
 * `/bin/zsh`, so a host whose shell differs does not silently skip the whole suite.
 */
export function skipReason(agent: AgentName): string | undefined {
  const envKey = `ELWOOD_E2E_SKIP_${agent.toUpperCase()}`;
  if (process.env[envKey] === "1") return `${envKey}=1`;
  if (!probed.has(agent)) probed.set(agent, probe(agent));
  return probed.get(agent);
}

function probe(agent: AgentName): string | undefined {
  const shell = userShell();
  const result = spawnSync(shell, [...probeShellCommand(`command -v ${agent}`)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
  });
  if (result.status === 0) return undefined;
  const detail = result.error ? ` (${result.error.message})` : "";
  return `${agent} CLI does not resolve in the login shell ${shell}${detail}`;
}

/**
 * The `skip` option for a real-agent test: the first reason given, or `false` to run.
 * Accepts `undefined`/`false` entries so callers can list every condition inline
 * (`skipIf(skipReason("codex"), skipTurns, codexAuthMissing())`). A skip is announced
 * on stderr with its reason; under `ELWOOD_E2E_REQUIRE=1` it throws instead, failing
 * the file at registration.
 */
export function skipIf(...reasons: readonly (string | false | undefined)[]): string | false {
  const reason = reasons.find((entry): entry is string => typeof entry === "string");
  if (reason === undefined) return false;
  if (requireAll) throw new Error(`ELWOOD_E2E_REQUIRE=1 refuses to skip: ${reason}`);
  process.stderr.write(`e2e skip: ${reason}\n`);
  return reason;
}

/**
 * A skip decided mid-test (for example, the real CLI rendered no trust frame): marks
 * the test skipped with the reason, or fails it under `ELWOOD_E2E_REQUIRE=1`.
 */
export function skipNow(t: TestContext, reason: string): void {
  if (requireAll) throw new Error(`ELWOOD_E2E_REQUIRE=1 refuses to skip: ${reason}`);
  process.stderr.write(`e2e skip: ${reason}\n`);
  t.skip(reason);
}
