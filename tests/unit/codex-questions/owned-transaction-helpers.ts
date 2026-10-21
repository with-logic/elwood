/** Start and clean up real owned-answer transactions over scripted terminals (PRD §4). */
import { afterEach } from "vitest";
import { QuestionTransaction } from "../../../src/core/questions/transaction.ts";
import { PickerInputOwnership } from "../../../src/runtime/session/picker-input.ts";
import { createOwnedInteraction } from "./owned-transaction-interaction.ts";
import {
  answerText,
  type BindingOptions,
  setupOwnedScenario,
} from "./owned-transaction-scenario.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  const results = await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  for (const result of results) if (result.status === "rejected") throw result.reason;
});
function startOwnedTransaction(
  scenario: ReturnType<typeof setupOwnedScenario>,
  interaction: ReturnType<typeof createOwnedInteraction>,
  closing: AbortSignal,
) {
  const ownership = new PickerInputOwnership(interaction.terminal);
  const transaction = new QuestionTransaction(
    scenario.registry,
    ownership.automated,
    () => ownership.signal(),
    closing,
  );
  const pending = transaction.run(
    scenario.adapter,
    scenario.request.id,
    scenario.request.questions.map((question, index) => ({
      questionId: question.id,
      text: answerText(scenario, index),
    })),
    { timeoutMs: scenario.options.probe?.timeoutMs ?? 3000 },
  );
  const result = Promise.race([
    pending.then(
      () => "answered",
      () => "failed",
    ),
    interaction.paintFailed,
  ]);
  void result.catch(() => {});
  return { transaction, result };
}
export async function transactionBinding(options: BindingOptions) {
  const scenario = setupOwnedScenario(options);
  const closing = new AbortController();
  const interaction = createOwnedInteraction(scenario, closing);
  let transactionResult: Promise<string> | undefined;
  const dispose = async () => {
    closing.abort();
    const settled = await Promise.allSettled([transactionResult, interaction.settled()]);
    interaction.terminal.dispose();
    const paint = settled[1];
    if (paint?.status === "rejected") throw paint.reason;
  };
  cleanups.push(dispose);
  await interaction.paint(scenario.initial);
  const started = startOwnedTransaction(scenario, interaction, closing.signal);
  transactionResult = started.result;
  return { ...scenario, ...started, ...interaction, dispose };
}
