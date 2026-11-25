/** Observe Codex workspace trust confirmation and exit after a verified key (C-ATTN-07). */
import type { WorkspaceTrustAnswers } from "../../core/dialogs/trust-answer/index.ts";
import type { PtyExit } from "../../pty/types.ts";
import {
  cachedLiveSnapshot,
  nativeRenderEvidenceIntact,
  settledNativeSnapshot,
} from "../../terminal/cursor.ts";
import type { ElwoodTerminal, TerminalSnapshot, XtermTerminal } from "../../terminal/headless.ts";
import { terminalSnapshot } from "../../terminal/snapshot.ts";
import { workspaceTrustCompletion } from "./answer-layout.ts";
import type { CodexWorkspaceTrustDiscovery } from "./discovery.ts";
import type { WorkspaceTrustDiscoveryInput } from "./discovery-input.ts";
import { hasCompleteWorkspaceTrustDisclosure } from "./menu-frame.ts";
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
  let stopObservingQuitTail: (() => void) | undefined;
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
  const observeSynchronizedReplacement = (
    current: ElwoodTerminal,
    read: (terminal: ElwoodTerminal) => TerminalSnapshot,
  ) => {
    if (!nativeRenderEvidenceIntact(current)) return;
    const frame = read(current);
    const menu = discovery.matchObservedFrame(frame);
    const replaced = menu
      ? menu.identity !== claimedMenu
      : hasCompleteWorkspaceTrustDisclosure(current, frame);
    if (!replaced) return;
    if (settlingQuitRender) replacedQuit = true;
    else answers.revoke("frame");
  };
  const recordConfirmation = (source: "native-pty-render" | "write-completion") => {
    if (!answers.confirmationDispatched) return;
    revokeAnswerIfRequestChanged();
    const outcome = inspectNativeOutcome(() => {
      const current = terminal();
      if (source === "native-pty-render" && current.xterm.modes.synchronizedOutputMode) {
        // A complete replacement can vanish before synchronized output ends.
        // This native frame can only veto the answer. Acceptance still needs settlement.
        observeSynchronizedReplacement(current, cachedLiveSnapshot);
        return undefined;
      }
      const frame = settledNativeSnapshot(current);
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
    observeBeforeSynchronizedRepaint(current: ElwoodTerminal) {
      if (!answers.confirmationDispatched) return;
      inspectNativeOutcome(() => {
        if (!current.xterm.modes.synchronizedOutputMode) return;
        // The viewport can change inside a single write without updating the cached frame.
        observeSynchronizedReplacement(current, ({ xterm, size }) =>
          terminalSnapshot(xterm, size, xterm.buffer.active.baseY),
        );
      });
    },
    claim(menuIdentity: string) {
      claimedMenu = menuIdentity;
      claimedBuffer = terminal().xterm.buffer.active.type;
    },
    closing(stopObserving: () => void) {
      if (settlingQuitRender) {
        stopObservingQuitTail = stopObserving;
        return;
      }
      stopObserving();
      answers.revoke("frame");
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
          try {
            answers.nativeExit(settled && !replacedQuit && readQuitOutcome(current) === true);
          } finally {
            stopObservingQuitTail?.();
          }
        });
      }
    },
  };
}
