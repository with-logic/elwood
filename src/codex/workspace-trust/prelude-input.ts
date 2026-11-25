/** Carry raw input on a settled Codex workspace prelude into the existing responder (C-TRUST-01). */
import { isAbsolute } from "node:path";
import { codexFolderAccessHeader } from "../../core/trust/allowlist.ts";
import { hasTrustConversationBefore } from "../../core/trust/dialog.ts";
import type { TrustView } from "../../core/trust/view.ts";
import { nativeRenderEvidenceIntact, settledNativeSnapshot } from "../../terminal/cursor.ts";
import type { ElwoodTerminal } from "../../terminal/headless.ts";

import { readWorkspacePrelude, type WorkspacePrelude } from "./disclosure.ts";

type Layout = WorkspacePrelude["layout"];

function preludeLayout(lines: readonly string[]): Layout | undefined {
  for (const [row, line] of lines.entries()) {
    const prelude = readWorkspacePrelude(line);
    if (!prelude || (prelude.layout === "legacy" && !isAbsolute(prelude.location))) continue;
    return hasTrustConversationBefore(lines, row) ? undefined : prelude.layout;
  }
  return undefined;
}

function hasTrustCandidateOrUnknownGate(view: TrustView): boolean {
  switch (view.kind) {
    case "candidate":
      return true;
    case "unknown":
      return view.gate === true;
    case "clear":
      return false;
  }
}

export type CodexWorkspaceTrustHooks = {
  readonly prelude: ReturnType<typeof trackWorkspacePreludeInput>;
  readonly onTakeover: () => void;
};

/**
 * Remember the last settled native prelude until a settled replacement, loss of
 * provenance, or startup end. Raw input claims it even while native output is
 * queued, and only the compatible workspace question can consume that claim.
 */
export function trackWorkspacePreludeInput(terminal: () => ElwoodTerminal) {
  let active: { visible: Layout | undefined; pending: Layout | undefined } | undefined = {
    visible: undefined,
    pending: undefined,
  };
  return {
    record(): void {
      if (!active) return;
      const current = terminal();
      if (!current.renderFailed && nativeRenderEvidenceIntact(current))
        active.pending = active.visible;
    },
    consumePendingClaim(view: TrustView): boolean {
      if (!active) return false;
      const frame = settledNativeSnapshot(terminal());
      if (!frame) return false;
      active.visible = hasTrustCandidateOrUnknownGate(view)
        ? undefined
        : preludeLayout(frame.lines);
      const { pending } = active;
      if (!pending) return false;
      if (view.kind === "candidate" && view.spec.id === "workspace_trust") {
        active.pending = undefined;
        const modernQuestion = codexFolderAccessHeader.test(view.dialog.header);
        return modernQuestion ? pending === "folder access" : pending === "legacy";
      }
      if (active.visible !== pending) active.pending = undefined;
      return false;
    },
    end(): void {
      active = undefined;
    },
  };
}
