/**
 * Lifecycle preflight warning shapes split out of the main warning union (§9.2, C-LIFE-11) to
 * keep `warnings.ts` under the file-size cap. These are ordinary `ElwoodWarningEvent` members.
 */

/**
 * Best-effort `claude update` / `codex update` failed but the INSTALLED CLI still meets the
 * minimum, so the session started from it. Safe diagnostics only: the installed version in use,
 * an allowlisted `errorCode` (a probe timeout/`errno`), and bounded `raw` stderr — never terminal
 * transcripts, prompts, tokens, or environment secrets.
 */
export type AgentUpdateFailedWarning = {
  readonly elwoodSessionId: string;
  readonly agent: "claude" | "codex";
  readonly source: "lifecycle";
  readonly code: "agent_update_failed";
  readonly severity: "warning";
  readonly message: string;
  readonly installedVersion: string;
  readonly errorCode: string;
  readonly raw: string;
};
