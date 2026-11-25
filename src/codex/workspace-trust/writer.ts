/** Confirm verified Codex workspace trust choices through the live PTY (C-ATTN-07). */
import { WorkspaceTrustAnswers } from "../../core/dialogs/trust-answer/index.ts";
import type { ElwoodDialogAnswerOptions } from "../../core/dialogs/types.ts";
import type { PtyExit } from "../../pty/types.ts";
import { onCallerInput } from "../../runtime/session/session-input.ts";
import {
  nativeRenderEvidenceIntact,
  onNativeRenderEvidenceInvalidated,
  settledNativeSnapshot,
} from "../../terminal/cursor.ts";
import type { ElwoodTerminal, XtermTerminal } from "../../terminal/headless.ts";
import {
  codexWorkspaceTrustStep,
  type NumberedTrustOption,
  workspaceTrustCompletion,
} from "./answer-layout.ts";
import type { CodexWorkspaceTrustDiscovery } from "./discovery.ts";
import type { WorkspaceTrustDiscoveryInput } from "./discovery-input.ts";
import { restoredQuitBuffer, settleQuitRender } from "./quit-render.ts";
import { matchWorkspaceMenu } from "./target.ts";

type WriterInput = Pick<WorkspaceTrustDiscoveryInput, "terminal" | "clearance"> & {
  readonly manualTrust: boolean;
  readonly discovery: CodexWorkspaceTrustDiscovery;
  readonly deliveryRevision: () => number;
  readonly write: (keys: string) => Promise<void>;
};
export function codexTrustWriter({
  terminal,
  clearance,
  manualTrust,
  discovery,
  deliveryRevision,
  write,
}: WriterInput) {
  let relinquished = false;
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
  const answers: WorkspaceTrustAnswers<NumberedTrustOption, 0 | 1> = new WorkspaceTrustAnswers({
    currentRequest: () => {
      const current = discovery.currentRequestWithDeclineOutcome;
      if (!(manualTrust && current)) return undefined;
      const { request, declineOutcome } = current;
      answers.revokeIfGateChanged(request.id);
      return {
        request,
        gateIdentity: request.id,
        choices: request.choices.map(({ id }, index) => ({
          id,
          choiceIndex: index === 0 ? 0 : 1,
          outcome: index === 0 ? "affirmative" : declineOutcome,
        })),
      };
    },
    readChoice: (_gate, index, requestId, previousFrame, finish, signal) => {
      // Wait for every synchronous dialog observer before collecting Git evidence.
      void Promise.resolve()
        .then(async () => {
          if (signal.aborted || relinquished) return undefined;
          const candidate = discovery.reconcileCandidate();
          if (!candidate || candidate.frame === previousFrame) return undefined;
          const { frame, menu } = candidate;
          const revision = deliveryRevision();
          const stillCurrent = () =>
            revision === deliveryRevision() &&
            !relinquished &&
            discovery.isRequestIdAtFrame(requestId, frame);
          const resume =
            previousFrame &&
            (() => {
              if (!signal.aborted) answers.resumeNavigation();
            });
          const result = await discovery.verifyRequestForAnswer(
            candidate,
            signal,
            stillCurrent,
            resume,
          );
          if (result === "expired" && !signal.aborted && stillCurrent()) answers.revoke("frame");
          if (result !== "verified") return undefined;
          return {
            frame,
            option: menu.dialog.options[index],
            claim: () => {
              if (!stillCurrent()) return false;
              claimedMenu = candidate.identity;
              claimedBuffer = terminal().xterm.buffer.active.type;
              return true;
            },
          };
        })
        .then(finish)
        .catch(() => finish());
    },
    step: codexWorkspaceTrustStep,
    write,
    reconcileDialogEvidence: recordConfirmation,
    relinquish: () => {
      relinquished = true;
    },
  });
  return {
    answerDialog: (id: string, choice: string, options?: ElwoodDialogAnswerOptions) =>
      answers.answer(id, choice, options),
    recordConfirmation,
    retireNavigation: (id: string) => answers.retireNavigation(id),
    resumeAfterDialogDelivery: () => answers.resumeNavigation(),
    bind(current: ElwoodTerminal, closing: AbortSignal) {
      const offInput = onCallerInput(current, () => {
        relinquished = true;
        answers.revoke();
      });
      const offNative = onNativeRenderEvidenceInvalidated(current, () => answers.revoke());
      closing.addEventListener(
        "abort",
        () => {
          offInput();
          offNative();
          if (!settlingQuitRender) answers.revoke("frame");
        },
        { once: true },
      );
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
