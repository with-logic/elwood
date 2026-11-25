/** Observe Codex workspace trust confirmation and exit after a verified key (C-ATTN-07). */
import type { WorkspaceTrustAnswers } from "../../core/dialogs/trust-answer/index.ts";
import type { PtyExit } from "../../pty/types.ts";
import { nativeRenderEvidenceIntact, settledNativeSnapshot } from "../../terminal/cursor.ts";
import type { ElwoodTerminal, XtermTerminal } from "../../terminal/headless.ts";
import { workspaceTrustCompletion } from "./answer-layout.ts";
import type { CodexWorkspaceTrustDiscovery } from "./discovery.ts";
import type { WorkspaceTrustDiscoveryInput } from "./discovery-input.ts";
import { restoredQuitBuffer, settleQuitRender } from "./quit-render.ts";
import { matchWorkspaceMenu } from "./target.ts";

type ConfirmationInput = Pick<WorkspaceTrustDiscoveryInput, "terminal" | "clearance"> & {
  readonly discovery: CodexWorkspaceTrustDiscovery;
  readonly answers: Pick<
    WorkspaceTrustAnswers,
    | "awaitingNativeExit"
    | "confirmationDispatched"
    | "nativeExit"
    | "recordConfirmation"
    | "resumeNavigation"
    | "revoke"
    | "revokeIfGateChanged"
  >;
};

export function codexTrustConfirmation({
  terminal,
  clearance,
  discovery,
  answers,
}: ConfirmationInput) {
  let claimedMenu: string | undefined;
  let claimedBuffer: XtermTerminal["buffer"]["active"]["type"] | undefined;
  let settlingQuitRender = false;
  let replacedQuit = false;
  const revokeAnswerIfRequestChanged = () =>
    answers.revokeIfGateChanged(discovery.currentRequestId);
  const inspectNativeOutcome = <T>(inspect: () => T): T | undefined => {
    try {
      return inspect();
    } catch {
      answers.revoke("frame");
      return undefined;
    }
  };
  const recordConfirmation = () => {
    if (!answers.confirmationDispatched) return;
    revokeAnswerIfRequestChanged();
    const outcome = inspectNativeOutcome(() => {
      const frame = settledNativeSnapshot(terminal());
      return frame && workspaceTrustCompletion(frame, clearance);
    });
    if (outcome) answers.recordConfirmation(outcome);
  };
  const readQuitOutcome = (current: ElwoodTerminal) =>
    inspectNativeOutcome(() => {
      const frame = settledNativeSnapshot(current);
      if (!frame) return undefined;
      const match = discovery.matchObservedFrame(frame);
      if (match && match.identity === claimedMenu) return match.menu.dialog.options[1].selected;
      return restoredQuitBuffer(claimedBuffer, current, frame);
    });
  const observePendingQuitFrame = () => {
    const frame = settledNativeSnapshot(terminal());
    if (!(frame && matchWorkspaceMenu(frame.lines))) return;
    replacedQuit ||= discovery.matchObservedFrame(frame)?.identity !== claimedMenu;
  };
  return {
    recordConfirmation,
    claim(menuIdentity: string) {
      claimedMenu = menuIdentity;
      claimedBuffer = terminal().xterm.buffer.active.type;
    },
    closing() {
      if (!settlingQuitRender) answers.revoke("frame");
    },
    observeFrame(menuIdentity: string | undefined) {
      if (settlingQuitRender) {
        inspectNativeOutcome(observePendingQuitFrame);
        return;
      }
      revokeAnswerIfRequestChanged();
      if (answers.confirmationDispatched && menuIdentity !== claimedMenu) {
        const replacement =
          menuIdentity ??
          inspectNativeOutcome(() => {
            const frame = settledNativeSnapshot(terminal());
            return frame && matchWorkspaceMenu(frame.lines);
          });
        if (replacement) answers.revoke("frame");
      }
      answers.resumeNavigation();
    },
    nativeExit({ exitCode, signal }: PtyExit) {
      const current = terminal();
      if (!nativeRenderEvidenceIntact(current)) {
        answers.revoke();
        return;
      }
      const cleanQuit = exitCode === 0 && !signal && answers.awaitingNativeExit;
      const outcome = cleanQuit && readQuitOutcome(current);
      if (outcome !== undefined) {
        answers.nativeExit(outcome);
        return;
      }
      // Let already-received native output veto Quit without delaying session exit.
      settlingQuitRender = answers.awaitingNativeExit;
      if (settlingQuitRender) {
        settleQuitRender(current, (settled) => {
          settlingQuitRender = false;
          answers.nativeExit(settled && !replacedQuit && readQuitOutcome(current) === true);
        });
      }
    },
  };
}
