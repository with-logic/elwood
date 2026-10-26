/**
 * Decides whether a real-agent e2e test can run on this host (PRD §12, C-E2E-04):
 * probes each CLI through the SAME login shell resolution the product uses
 * (`userShell()` + `command -v`, see `src/cli/request/agent-detect.ts`), memoized per agent,
 * and folds every skip condition through one helper so a second condition is never
 * silently discarded. `ELWOOD_E2E_REQUIRE=1` turns any skip into a failure so a CI
 * host missing a CLI cannot exit green with nothing exercised.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { probeCommandTimeoutMs, probeLaunchTimeoutMs } from "../../src/runtime/probe/index.ts";
import { probeStartScript } from "../../src/runtime/probe/start.ts";
import { loginShellCommand, shellQuote, userShell } from "../../src/runtime/shell.ts";
import { e2eRunDir } from "./run-dir.ts";

export type AgentName = "claude" | "codex";

export const turnsEnabled = process.env["ELWOOD_E2E_SKIP_TURNS"] !== "1";
/** Skip reason for tests that run a real model turn; `undefined` when turns are on. */
export const skipTurns = turnsEnabled ? undefined : "ELWOOD_E2E_SKIP_TURNS=1 disables turn flows";
/** With `ELWOOD_E2E_REQUIRE=1` a would-be skip is a failure (CI must exercise the CLIs). */
export const requireAll = process.env["ELWOOD_E2E_REQUIRE"] === "1";

/** A CLI that resolves, and its path, `null` for a shell function, or why it does not. */
type Probed = { readonly path: string | null } | { readonly skip: string };
const probed = new Map<AgentName, Probed>();

/**
 * Each e2e file runs in its own worker, so the in-process memo alone would re-probe once per
 * file, up to the full probe bound each time on a stalled profile. Under `npm run test:e2e`
 * the workers share the runner's run dir (`run-dir.ts`), and through it each probe's result,
 * which is removed with the run dir when the run ends.
 */
const sharedResults = join(e2eRunDir, "availability.json");

function readShared(): Partial<Record<AgentName, Probed>> {
  if (!existsSync(sharedResults)) return {};
  return JSON.parse(readFileSync(sharedResults, "utf8")) as Partial<Record<AgentName, Probed>>;
}

function probedAgent(agent: AgentName): Probed {
  const known = probed.get(agent) ?? readShared()[agent];
  if (known) {
    probed.set(agent, known);
    return known;
  }
  const fresh = probe(agent);
  probed.set(agent, fresh);
  const staged = `${sharedResults}.${process.pid}`;
  writeFileSync(staged, JSON.stringify({ ...readShared(), [agent]: fresh }));
  renameSync(staged, sharedResults);
  return fresh;
}

/**
 * Why `agent` cannot be exercised here, or `undefined` when it can. The probe runs
 * once per agent per e2e run (each `test()` registration used to spawn a fresh
 * interactive login shell) and uses the user's own shell rather than a hard-coded
 * `/bin/zsh`, so a host whose shell differs does not silently skip the whole suite.
 */
export function skipReason(agent: AgentName): string | undefined {
  const envKey = `ELWOOD_E2E_SKIP_${agent.toUpperCase()}`;
  if (process.env[envKey] === "1") return `${envKey}=1`;
  const result = probedAgent(agent);
  return "skip" in result ? result.skip : undefined;
}

/**
 * Why a test that needs `agent`'s program path cannot run here, or `undefined` when it can:
 * every reason `skipReason` gives, and a CLI the login shell resolves only as a function.
 */
export function pathSkipReason(agent: AgentName): string | undefined {
  const reason = skipReason(agent);
  if (reason !== undefined) return reason;
  const result = probedAgent(agent);
  return "path" in result && result.path === null
    ? `${agent} resolves only as a login-shell function, with no program path`
    : undefined;
}

/** The absolute path the user's login shell resolves `agent` to, from the same memoized probe. */
export function resolvedAgentPath(agent: AgentName): string {
  const result = probedAgent(agent);
  if ("skip" in result) throw new Error(result.skip);
  if (result.path === null) throw new Error(`${agent} resolves only as a login-shell function`);
  return result.path;
}

function probe(agent: AgentName): Probed {
  const shell = userShell();
  // Found as detection finds it, by the login shell's own `command -v`, which also finds a
  // function zsh can `exec`; then the program's path, from `/bin/sh`, if it is one. Its output
  // goes to plain files in a directory of this run's, by the probe script's own redirection.
  // Nothing else is read: the shell's own streams, and the start line's descriptor, are closed.
  const output = mkdtempSync(join(e2eRunDir, "probe-"));
  const [stdout, stderr] = [join(output, "stdout"), join(output, "stderr")];
  const script =
    `${probeStartScript}command -v ${agent} >/dev/null 2>&1 || exit 1; ` +
    `exec /bin/sh -c 'command -v "$1" || :' sh ${agent} >${shellQuote(stdout)} 2>${shellQuote(stderr)}`;
  const result = spawnSync(shell, [...loginShellCommand(script)], {
    stdio: "ignore",
    // The production probe's launch plus command bounds (§9.2, C-PERF-05): a loaded host's
    // interactive profile alone can exceed 15 s, which must not read as a missing CLI.
    timeout: probeLaunchTimeoutMs + probeCommandTimeoutMs,
  });
  const path = existsSync(stdout) ? readFileSync(stdout, "utf8").trim() : "";
  rmSync(output, { recursive: true, force: true });
  if (result.status === 0) return { path: path || null };
  const detail = result.error ? ` (${result.error.message})` : "";
  return { skip: `${agent} CLI does not resolve in the login shell ${shell}${detail}` };
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
