/** Observe asynchronous terminal paints and native acknowledgement (PRD §4). */
import type { QuestionFrame } from "../../../src/core/questions/adapter.ts";
import { createHeadlessTerminal } from "../../../src/terminal/headless.ts";
import { selector } from "./owned-fixtures.ts";
import {
  acknowledgeNative,
  type OwnedScenario,
  typedFrame,
  unreachableMode,
} from "./owned-transaction-scenario.ts";

export function createOwnedInteraction(scenario: OwnedScenario, closing: AbortController) {
  const writes: string[] = [];
  let index = 0;
  let acknowledgeAction: (() => void) | undefined;
  let failure: { readonly error: unknown } | undefined;
  let pending = Promise.resolve();
  const { promise: paintFailed, reject: rejectPaint } = Promise.withResolvers<never>();
  void paintFailed.catch(() => {});
  const { promise: ready, resolve: markReady } = Promise.withResolvers<void>();
  const terminal = createHeadlessTerminal({ cols: 140, rows: 45 }, (input) => {
    const text = String(input);
    writes.push(text);
    pending = pending
      .then(() => interact(text))
      .catch((error: unknown) => {
        failure ??= { error };
        closing.abort(error);
        rejectPaint(error);
      });
  });
  async function paint(frame: QuestionFrame): Promise<void> {
    await terminal.writeOutput(
      `\x1b[2J\x1b[H${frame.cursorCellDimmed ? "\x1b[2m" : "\x1b[22m"}${frame.lines.join("\r\n")}\x1b[${frame.cursorY + 1};${frame.cursorX + 1}H\x1b[?25h`,
    );
  }
  async function interact(text: string): Promise<void> {
    if (text === "\t") await paint(index === 0 ? scenario.literal : scenario.modalLong);
    if (text.startsWith("\x1b[200~")) await paint(typedFrame(scenario, index));
    if (text !== "\r") return;
    switch (scenario.options.mode) {
      case "queued":
        break;
      case "modal":
        if (!scenario.options.probe && index++ === 0) {
          await paint(selector(scenario.modalLong));
          return;
        }
        break;
      default:
        unreachableMode(scenario.options.mode);
    }
    acknowledgeAction = () => acknowledgeNative(scenario);
    markReady();
  }
  async function waitForAcknowledgement(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        ready,
        paintFailed,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Native acknowledgement was not ready")), 2500);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    terminal,
    writes,
    paint,
    paintFailed,
    waitForAcknowledgement,
    canAcknowledge: () => acknowledgeAction !== undefined,
    acknowledge: () => {
      if (failure) throw failure.error;
      if (!acknowledgeAction) throw new Error("Native acknowledgement is not ready");
      acknowledgeAction();
    },
    settled: async () => {
      await pending;
      if (failure) throw failure.error;
    },
  };
}
