/** Revalidate the active picker immediately before automation writes (PRD §5.3, C-API-23/24). */
import { elwoodError } from "../errors.ts";
import type { ModelPickerIo } from "./picker.ts";

export function sendPickerInput(
  io: Pick<ModelPickerIo, "terminal" | "blocked">,
  input: string,
  expected: (text: string) => boolean,
  ownsBlockingDialog = false,
): void | Promise<void> {
  if ((!ownsBlockingDialog && io.blocked?.()) || !expected(io.terminal.snapshot().text)) {
    throw elwoodError(
      "model_automation_failed",
      "The model picker was replaced before input could be sent.",
    );
  }
  return io.terminal.sendInput(input);
}
