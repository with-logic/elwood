/** Seed Claude turn correlation and recover matching pending submissions (C-API-63). */
import type { DropReporter } from "../../core/transcript/drops.ts";
import type { TranscriptCursor } from "./cursor.ts";
import type { LineEmitter } from "./emit.ts";
import type { TranscriptFsGuard } from "./fs-guard.ts";

export function observeTranscriptBaseline(
  cursor: TranscriptCursor,
  turnId: string | undefined,
  { turns, userPrompts }: LineEmitter,
  guard: TranscriptFsGuard,
  drops: DropReporter,
): void {
  const { path } = cursor;
  let seedReadFailed = false;
  turns.seed(path, turnId, () => {
    const seed = guard.read(path, () => ({ prompt: cursor.baselinePrompt() }));
    seedReadFailed = seed === undefined;
    return seed?.prompt;
  });
  if (turns.correlationDisabled) userPrompts.clearUnpaired();
  if (turnId === undefined) return;
  let malformed = false;
  userPrompts.recoverInitial(path, turnId, (pendingToken) => {
    // Do not read the same file twice after an earlier failure in this hook.
    if (seedReadFailed) {
      cursor.recordInitialLookupReadFailure(pendingToken);
      return undefined;
    }
    const initial = guard.read(path, () => cursor.takeLatestInitialPrompt(pendingToken));
    malformed = initial?.malformed === true;
    return initial?.prompt;
  });
  if (malformed) drops.emitDrop(path, "unparseable");
}
