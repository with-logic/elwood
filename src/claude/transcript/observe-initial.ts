/** Resolve a pending Claude hook from bounded initial transcript evidence (C-API-63). */
import type { TranscriptCursor } from "./cursor.ts";
import type { LineEmitter } from "./emit.ts";
import type { TranscriptFsGuard } from "./fs-guard.ts";

export function observeInitialUserPrompt(
  cursor: TranscriptCursor,
  turnId: string | undefined,
  { turns, userPrompts }: LineEmitter,
  guard: TranscriptFsGuard,
  drop: (path: string) => void,
): void {
  const { path } = cursor;
  let seedReadFailed = false;
  turns.seed(path, turnId, () => {
    const seed = guard.read(path, () => ({ prompt: cursor.baselinePrompt() }));
    seedReadFailed = seed === undefined;
    return seed?.prompt;
  });
  if (turns.correlationDisabled) userPrompts.clearUnpaired();
  // A failed identity read has already reported the filesystem problem for this hook.
  if (turnId === undefined || seedReadFailed) return;
  let malformed = false;
  userPrompts.recoverInitial(path, turnId, () => {
    const initial = guard.read(path, () => cursor.takeInitialPrompt(turnId));
    malformed = initial?.malformed === true;
    return initial?.prompt;
  });
  if (malformed) drop(path);
}
