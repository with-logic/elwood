/** Classifies native candidates separately from safe trust writes (PRD §5.4, C-TRUST-01). */
import type { ElwoodAgentKind } from "../activity/index.ts";
import type { SelectableOption } from "../terminal-options.ts";
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

/** Strict visibility remains distinct from the weaker candidate input guard. */
export function trustPromptVisible(text: string, agent: ElwoodAgentKind): boolean {
  const dialog = parseTrustDialog(text);
  return trustPromptAllowlist.some(
    (spec) => spec.agent === agent && activeTrustDialogVisible(dialog, spec),
  );
}

export function trustView(frame: string, agent: ElwoodAgentKind): TrustView {
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
  return { kind: nativeComposer(frame, agent) ? "clear" : "unknown" };
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

function nativeComposer(frame: string, agent: ElwoodAgentKind): boolean {
  const composerRow =
    agent === "codex"
      ? /^\s*›(?:\s*|\s+Ask Codex to do anything)\s*$/m
      : /^\s*❯(?:[ \t\u00a0]*|[ \t\u00a0]+Try "[^"\n]+")\s*$/m;
  if (
    /^\s*[❯›>]?\s*\d+[.)]\s+\S/m.test(frame) ||
    frame.split("\n").some((line) => /^\s*[❯›]/.test(line) && !composerRow.test(line))
  )
    return false;
  if (agent === "codex") {
    return (
      ((/^\s*│\s*>_ OpenAI Codex \(v[\d.]+\)/m.test(frame) && /^\s*╰─+╯\s*$/m.test(frame)) ||
        /^\s*gpt-[\w.-]+ (?:minimal|low|medium|high|xhigh|default) · (?:\/|[A-Z]:[\\/])[^\n]*$/m.test(
          frame,
        )) &&
      composerRow.test(frame)
    );
  }
  return (
    (/Claude Code v[\d.]+/.test(frame) ||
      /^\s*-- INSERT -- ⏵⏵ don['’]t ask on \(shift\+tab to cycle\) · ← for agents\s*$/m.test(
        frame,
      )) &&
    /(?:^|\n)[─━]{3,}\s*\n❯(?:[ \t\u00a0]*|[ \t\u00a0]+Try "[^"\n]+")\s*\n[─━]{3,}/.test(frame)
  );
}
