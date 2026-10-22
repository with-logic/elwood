/** Bound retained and pre-normalization question metadata for PRD §4 adapters. */
// Elwood resource policy, not native Codex limits: 1 MiB bounds each input or
// retained byte pool; 256 bounds per-input definitions and pending-entry fan-out.
// The 4096 retired-ID cap is 16 times the pending cap, allowing closed-call history
// for replay rejection while its separate 1 MiB cap also bounds long IDs. These are
// fixed resource ceilings, not measured native payload maxima.
export const questionMetadataLimitBytes = 1024 * 1024;
export const questionDefinitionCountLimit = 256;
export const pendingQuestionCountLimit = 256;
const retiredQuestionIdentityCountLimit = 4096;
export class QuestionLimitError extends Error {}

export function checkQuestionInput(value: unknown, callId = ""): void {
  if (Array.isArray(value) && value.length > questionDefinitionCountLimit)
    throw new QuestionLimitError();
  let serialized: string;
  try {
    serialized = JSON.stringify([callId, value]);
  } catch {
    throw new QuestionLimitError();
  }
  if (Buffer.byteLength(serialized) > questionMetadataLimitBytes) throw new QuestionLimitError();
}
export function checkQuestionArguments(value: unknown, callId: unknown): void {
  const bytes =
    (typeof value === "string" ? Buffer.byteLength(value) : 0) +
    (typeof callId === "string" ? Buffer.byteLength(callId) : 0);
  if (bytes > questionMetadataLimitBytes) throw new QuestionLimitError();
}
export class QuestionBudget {
  private readonly retired = new Set<string>();
  private retiredBytes = 0;
  private candidateBytes = 0;
  hasRetired(key: string): boolean {
    return this.retired.has(key);
  }
  replace(count: number, deltaBytes: number): void {
    if (
      count > pendingQuestionCountLimit ||
      this.candidateBytes + deltaBytes > questionMetadataLimitBytes
    )
      throw new QuestionLimitError();
    this.candidateBytes += deltaBytes;
  }
  retire(key: string): void {
    if (this.retired.has(key)) return;
    const bytes = Buffer.byteLength(key);
    if (
      this.retired.size === retiredQuestionIdentityCountLimit ||
      this.retiredBytes + bytes > questionMetadataLimitBytes
    )
      throw new QuestionLimitError();
    this.retired.add(key);
    this.retiredBytes += bytes;
  }
  clear(): void {
    this.retired.clear();
    this.retiredBytes = 0;
    this.candidateBytes = 0;
  }
}
