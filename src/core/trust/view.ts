/**
 * Classifies native candidates separately from safe trust writes (PRD §5.4, C-TRUST-01).
 * The CLI-specific "this frame is the idle native composer" grammar is NOT here: each
 * adapter owns its own and injects it as `clearance`, so a layout change lands once.
 */
import type { ElwoodAgentKind } from "../activity/index.ts";
import type { SelectableOption } from "../terminal-options.ts";
import type { TrustClearance } from "./clearance.ts";
import { parseTrustCandidates, parseTrustDialog, type TrustDialog } from "./dialog.ts";
import { activeTrustDialogVisible, type TrustPromptSpec, trustPromptAllowlist } from "./prompts.ts";

export type TrustCandidate = {
  readonly kind: "candidate";
  readonly spec: TrustPromptSpec;
  readonly key: string;
  readonly dialog: TrustDialog;
  readonly valid: boolean;
  readonly option: SelectableOption | undefined;
};
export type TrustView = TrustCandidate | { readonly kind: "clear" } | { readonly kind: "unknown" };

/** A present reader with unavailable output must never become the permissive no-reader mode. */
export function readTrustView(
  readFrame: () => string | undefined,
  agent: ElwoodAgentKind,
  clearance: TrustClearance,
): TrustView | undefined {
  const frame = readFrame();
  return frame === undefined ? undefined : trustView(frame, agent, clearance);
}

/** Strict visibility remains distinct from the weaker candidate input guard. */
export function trustPromptVisible(text: string, agent: ElwoodAgentKind): boolean {
  const dialog = parseTrustDialog(text);
  return trustPromptAllowlist.some(
    (spec) => spec.agent === agent && activeTrustDialogVisible(dialog, spec),
  );
}

export function trustView(
  frame: string,
  agent: ElwoodAgentKind,
  clearance: TrustClearance,
): TrustView {
  const regions = parseTrustCandidates(frame);
  for (const region of regions) {
    for (const spec of trustPromptAllowlist) {
      if (spec.agent !== agent) continue;
      const header = spec.headerPattern.exec(region.dialog.header);
      if (header === null) continue;
      const valid = region.validTail && activeTrustDialogVisible(region.dialog, spec);
      return {
        kind: "candidate",
        spec,
        // Trimmed: the separator after a header varies as its body paints, the gate does not.
        key: `${spec.id}:${header[0].trim()}`,
        dialog: region.dialog,
        valid,
        option: valid
          ? region.dialog.options.find((option) => spec.accept.test(option.label))
          : undefined,
      };
    }
  }
  if (regions.length > 0) return { kind: "unknown" };
  return { kind: clearance(frame) ? "clear" : "unknown" };
}

/** Option identity excludes cursor position and later-painted native decline/footer rows. */
export function choiceIdentity(view: TrustCandidate): string | undefined {
  const option = view.option;
  if (option === undefined) return undefined;
  return JSON.stringify([
    view.dialog.header,
    option.style,
    option.label,
    option.style === "numbered" ? option.number : "",
  ]);
}
