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
  const attempt = (seedFailed: boolean) => {
    let readFailed = false;
    let malformed = false;
    userPrompts.recoverInitial(path, turnId, (pendingToken) => {
      if (seedFailed) {
        cursor.recordInitialLookupReadFailure(pendingToken);
        readFailed = true;
        return undefined;
      }
      const read = guard.read(path, () => ({
        result: cursor.takeLatestInitialPrompt(pendingToken),
      }));
      readFailed = read === undefined;
      malformed = read?.result?.malformed === true;
      return read?.result?.prompt;
    });
    if (malformed) drops.emitDrop(path, "unparseable");
    return readFailed;
  };
  if (attempt(seedReadFailed)) cursor.scheduleInitialRetry(() => attempt(false));
}
