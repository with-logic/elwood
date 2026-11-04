/** A current coordinator's affirmative completion pair for lease fixtures (PRD §9.2). */
import { writeFileSync } from "node:fs";
import {
  completionReceiptPath,
  serializeCompletionReceipt,
} from "../../src/runtime/update/completion.ts";

export function writeUpdateCompletion(path: string, generation: string): void {
  writeFileSync(completionReceiptPath(path), serializeCompletionReceipt(generation));
  writeFileSync(path, generation);
}
