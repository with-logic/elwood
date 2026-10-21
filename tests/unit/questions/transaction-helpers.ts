/** Transaction ownership over the shared real native-I/O fixture (PRD §4). */
import type { QuestionAdapter, QuestionIo } from "../../../src/core/questions/adapter.ts";
import { QuestionTransaction } from "../../../src/core/questions/transaction.ts";
import { disposeInputHarnesses, inputHarness } from "./input-helpers.ts";

const closings = new Set<AbortController>();
/** Revoke transaction authority, then settle tracked runs before disposing native I/O. */
export async function disposeTransactionHarnesses(): Promise<void> {
  for (const closing of closings) closing.abort();
  closings.clear();
  await disposeInputHarnesses();
}
export function transactionHarness(answer: (io: QuestionIo) => Promise<void>) {
  const h = inputHarness();
  closings.add(h.closing);
  const answers = [
    { questionId: h.request.questions[0]!.id, optionIds: [h.request.questions[0]!.options[0]!.id] },
  ];
  const adapter: QuestionAdapter = {
    observe: () => false,
    render: () => {},
    blocksInput: () => true,
    answer: (_request, _answers, io) => answer(io),
  };
  const transaction = new QuestionTransaction(
    h.requests,
    h.input.automated,
    () => h.input.signal(),
    h.closing.signal,
  );
  const run = transaction.run.bind(transaction);
  transaction.run = (...args) => h.track(run(...args));
  return { ...h, answers, adapter, transaction };
}
