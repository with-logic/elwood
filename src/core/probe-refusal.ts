/** Fixed probe-refusal context for launch errors and update warnings (PRD §9.2, C-API-61). */
import { ElwoodError, type ElwoodErrorName } from "./errors.ts";

export const probeCommandRefusedReason =
  "The probe command was refused because the original directory identity changed. Keep the workspace available and unchanged, then retry.";

const probes: ReadonlyMap<string, { readonly code: ElwoodErrorName; readonly label: string }> =
  new Map([
    ["`claude --version` failed.", { code: "claude_start_failed", label: "Claude version probe" }],
    ["`codex --version` failed.", { code: "codex_start_failed", label: "Codex version probe" }],
    ["`codex --help` failed.", { code: "codex_start_failed", label: "Codex help probe" }],
    ["`claude update` failed.", { code: "claude_update_failed", label: "Claude update probe" }],
    ["`codex update` failed.", { code: "codex_update_failed", label: "Codex update probe" }],
  ]);

/** Only known typed refusal causes and fixed probe messages can contribute display text. */
export function probeRefusalContext(error: unknown): string | undefined {
  if (
    !(error instanceof ElwoodError) ||
    error.details["cause"] !== probeCommandRefusedReason ||
    error.details["phase"] === "command_start_unobserved"
  )
    return undefined;
  const probe = probes.get(error.message);
  return probe?.code === error.code ? `${probe.label}: ${probeCommandRefusedReason}` : undefined;
}
