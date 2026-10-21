/** Real native input fixture without transaction ownership (PRD §4). */
import { vi } from "vitest";
import { questionAnswerFailed } from "../../../src/core/questions/errors.ts";
import { questionInput } from "../../../src/core/questions/input.ts";
import { PickerInputOwnership } from "../../../src/runtime/session/picker-input.ts";
import { createHeadlessTerminal } from "../../../src/terminal/headless.ts";
import { definitions, registry } from "./helpers.ts";

const cleanups: Array<() => Promise<void>> = [];
export async function disposeInputHarnesses(): Promise<void> {
  for (const cleanup of cleanups.splice(0)) await cleanup();
}
export function inputHarness() {
  const writes: string[] = [];
  const terminal = createHeadlessTerminal({ cols: 140, rows: 45 }, (input) =>
    writes.push(String(input)),
  );
  const input = new PickerInputOwnership(terminal);
  const closing = new AbortController();
  const operation = new AbortController();
  const requests = registry();
  const request = requests.publish("native", "blocking", [definitions[0]!])!;
  const signal = AbortSignal.any([closing.signal, operation.signal, input.signal()]);
  const started = vi.fn();
  const failed = vi.fn();
  const io = questionInput(
    input.automated,
    requests,
    request,
    signal,
    () => {
      if (signal.aborted) throw questionAnswerFailed();
    },
    { started, failed },
  );
  const pending = new Set<Promise<unknown>>();
  const track = <T>(work: Promise<T>): Promise<T> => {
    pending.add(work);
    void work.then(
      () => pending.delete(work),
      () => pending.delete(work),
    );
    return work;
  };
  cleanups.push(async () => {
    operation.abort();
    try {
      await Promise.allSettled([...pending]);
      requests.shutdown();
    } finally {
      terminal.dispose();
    }
  });
  return {
    writes,
    terminal,
    input,
    closing,
    operation,
    requests,
    request,
    io,
    started,
    failed,
    track,
  };
}
