/**
 * Selects the CLI agent, auto-detecting one when no flag, environment variable,
 * or config key chooses it. Implements PRD §12A.1/§12A.4 and C-CLI-03/C-CLI-21:
 * probe `claude` and `codex` concurrently and keep the first, in that order,
 * whose command resolves in the user's login shell — the same resolution the
 * agent PTY launch uses (§4.2) — without running either agent. A probe that
 * cannot run at all is reported as such, not as "no agent installed".
 */

import { currentCommandRunner } from "../../runtime/seams.ts";
import { probeShellCommand, shellQuote, userShell } from "../../runtime/shell.ts";
import { type CliAgent, CliValidationError } from "../types.ts";
import { layered, type SourcedValue, sourced } from "./sources.ts";

/** Detection order: the first agent whose command resolves wins. */
export const agentDetectionOrder = ["claude", "codex"] as const satisfies readonly CliAgent[];

/** Provenance reported for an auto-detected agent (`config effective`, JSON, verbose). */
export const autoDetectedSource = "auto-detected";

export type AgentDetector = () => Promise<CliAgent>;
type AgentProbe = (agent: CliAgent) => Promise<boolean>;

export const noAgentFoundMessage =
  "No agent was found: neither `claude` nor `codex` resolves in your login shell. " +
  "Install Claude Code (npm install -g @anthropic-ai/claude-code) or Codex " +
  "(npm install -g @openai/codex), or select one with --agent, ELWOOD_AGENT, " +
  "or `elwood config set agent <claude|codex>`.";

/**
 * True when the login shell resolves `agent` as a command. Uses the same
 * interactive login shell as the agent PTY so PATH resolution is identical, but
 * asks only `command -v`, so the agent itself never starts (C-CLI-14). A probe
 * that could not run at all (missing or broken shell, probe timeout) is a
 * distinct failure: it says nothing about which agents are installed.
 */
export async function loginShellResolves(
  agent: CliAgent,
  shell: string = userShell(),
): Promise<boolean> {
  const command = probeShellCommand(`command -v ${shellQuote(agent)}`);
  const result = await currentCommandRunner()(shell, command);
  if (result.error !== undefined) {
    throw new CliValidationError("no_agent_found", probeFailedMessage(shell, result.error));
  }
  return result.status === 0;
}

function probeFailedMessage(shell: string, error: { readonly code?: string | undefined }): string {
  const reason = error.code === undefined ? "did not run" : `failed with ${error.code}`;
  return (
    `No agent was found because the probe itself failed: login shell ${JSON.stringify(shell)} ` +
    `${reason} while checking for \`claude\` and \`codex\`. Fix the shell, or select an agent ` +
    "with --agent, ELWOOD_AGENT, or `elwood config set agent <claude|codex>`."
  );
}

/**
 * Probes every agent concurrently and returns the first in detection order that
 * `probe` reports available; `no_agent_found` when none is.
 */
export async function detectAvailableAgent(
  probe: AgentProbe = loginShellResolves,
): Promise<CliAgent> {
  const available = await Promise.all(agentDetectionOrder.map((agent) => probe(agent)));
  const found = agentDetectionOrder.find((_agent, index) => available[index] === true);
  if (found === undefined) throw new CliValidationError("no_agent_found", noAgentFoundMessage);
  return found;
}

type AgentSelection = {
  readonly flag: string | undefined;
  readonly env: CliAgent | undefined;
  readonly config: SourcedValue<CliAgent>;
  readonly resuming: boolean;
};

/**
 * Flag > env > config precedence for the agent (C-CLI-14). Without a choice, a
 * new session auto-detects; a resume keeps a placeholder that
 * `finalizeRunRequest` replaces with the stored adapter, so resume never probes.
 */
export async function selectAgent(
  selection: AgentSelection,
  detect: AgentDetector,
): Promise<SourcedValue<string>> {
  const chosen = layered<string>(
    sourced(selection.flag, "--agent"),
    sourced(selection.env, "ELWOOD_AGENT"),
    selection.config,
    sourced<string>(undefined, autoDetectedSource),
  );
  if (chosen.value !== undefined) return chosen;
  if (selection.resuming) return sourced("codex", "stored session");
  return sourced(await detect(), autoDetectedSource);
}
