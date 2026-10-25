/**
 * Decides whether a real-agent e2e test can run on this host (PRD §12, C-E2E-04):
 * probes each CLI through the SAME login shell resolution the product uses
 * (`userShell()` + `command -v`, see `src/cli/request/agent-detect.ts`), memoized per agent,
 * and folds every skip condition through one helper so a second condition is never
 * silently discarded. `ELWOOD_E2E_REQUIRE=1` turns any skip into a failure so a CI
 * host missing a CLI cannot exit green with nothing exercised.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { probeCommandTimeoutMs, probeLaunchTimeoutMs } from "../../src/runtime/probe/index.ts";
import { probeShellCommand, userShell } from "../../src/runtime/shell.ts";

export type AgentName = "claude" | "codex";

export const e2eTimeoutMs = Number(process.env["ELWOOD_E2E_TIMEOUT_MS"] ?? 180_000);
export const turnsEnabled = process.env["ELWOOD_E2E_SKIP_TURNS"] !== "1";
/** Skip reason for tests that run a real model turn; `undefined` when turns are on. */
export const skipTurns = turnsEnabled ? undefined : "ELWOOD_E2E_SKIP_TURNS=1 disables turn flows";
/** With `ELWOOD_E2E_REQUIRE=1` a would-be skip is a failure (CI must exercise the CLIs). */
export const requireAll = process.env["ELWOOD_E2E_REQUIRE"] === "1";

type Probed = { readonly path: string } | { readonly skip: string };
const probed = new Map<AgentName, Probed>();

/**
 * Each e2e file runs in its own worker, so the in-process memo alone would re-probe once per
 * file, up to the full probe bound each time on a stalled profile. Under `node --test` the
 * workers share one runner, so they share its result through a file named for the runner.
 */
const sharedResults =
  process.env["NODE_TEST_CONTEXT"] === undefined
    ? undefined
    : join(tmpdir(), `elwood-e2e-availability-${process.ppid}.json`);

function readShared(): Partial<Record<AgentName, Probed>> {
  if (sharedResults === undefined || !existsSync(sharedResults)) return {};
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
  if (sharedResults !== undefined) {
    const staged = `${sharedResults}.${process.pid}`;
    writeFileSync(staged, JSON.stringify({ ...readShared(), [agent]: fresh }));
    renameSync(staged, sharedResults);
  }
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

/** The absolute path the user's login shell resolves `agent` to, from the same memoized probe. */
export function resolvedAgentPath(agent: AgentName): string {
  const result = probedAgent(agent);
  if ("skip" in result) throw new Error(result.skip);
  return result.path;
}

function probe(agent: AgentName): Probed {
  const shell = userShell();
  const result = spawnSync(shell, [...probeShellCommand(`command -v ${agent}`)], {
    encoding: "utf8",
    // The fourth pipe receives the probe shell's start line, as `runProbe`'s does.
    stdio: ["ignore", "pipe", "pipe", "pipe"],
    // The production probe's launch plus command bounds (§9.2, C-PERF-05): a loaded host's
    // interactive profile alone can exceed 15 s, which must not read as a missing CLI.
    timeout: probeLaunchTimeoutMs + probeCommandTimeoutMs,
  });
  // `command -v` prints the path last; an interactive profile may print its own lines first.
  const path = result.stdout.trim().split("\n").at(-1);
  if (result.status === 0 && path) return { path };
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
