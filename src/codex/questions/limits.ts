/** Bound retained and pre-normalization question metadata (PRD §7A.5, C-QUESTION-05). */
export const questionMetadataLimit = 1024 * 1024;
export const questionUnitLimit = 256;
export class QuestionLimitError extends Error {}

export function checkQuestionInput(value: unknown, identity = ""): void {
  if (Array.isArray(value) && value.length > questionUnitLimit) throw new QuestionLimitError();
  let serialized: string;
  try {
    serialized = JSON.stringify([identity, value]);
  } catch {
    throw new QuestionLimitError();
  }
  if (Buffer.byteLength(serialized) > questionMetadataLimit) throw new QuestionLimitError();
}
export function checkQuestionArguments(value: unknown, identity: unknown): void {
  const bytes =
    (typeof value === "string" ? Buffer.byteLength(value) : 0) +
    (typeof identity === "string" ? Buffer.byteLength(identity) : 0);
  if (bytes > questionMetadataLimit) throw new QuestionLimitError();
}
export class QuestionBudget {
  private readonly retired = new Set<string>();
  private retiredBytes = 0;
  private candidateBytes = 0;
  hasRetired(key: string): boolean {
    return this.retired.has(key);
  }
  replace(count: number, deltaBytes: number): void {
    if (count > questionUnitLimit || this.candidateBytes + deltaBytes > questionMetadataLimit)
      throw new QuestionLimitError();
    this.candidateBytes += deltaBytes;
  }
  retire(key: string): void {
    if (this.retired.has(key)) return;
    const bytes = Buffer.byteLength(key);
    if (this.retired.size === 4096 || this.retiredBytes + bytes > questionMetadataLimit)
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
