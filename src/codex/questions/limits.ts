/** Bound retained and pre-normalization question metadata for PRD §4 adapters. */
export const questionMetadataLimitBytes = 1024 * 1024;
export const questionDefinitionCountLimit = 256;
export const pendingQuestionCountLimit = 256;
const retiredQuestionIdentityCountLimit = 4096;
export class QuestionLimitError extends Error {}

export function checkQuestionInput(value: unknown, identity = ""): void {
  if (Array.isArray(value) && value.length > questionDefinitionCountLimit)
    throw new QuestionLimitError();
  let serialized: string;
  try {
    serialized = JSON.stringify([identity, value]);
  } catch {
    throw new QuestionLimitError();
  }
  if (Buffer.byteLength(serialized) > questionMetadataLimitBytes) throw new QuestionLimitError();
}
export function checkQuestionArguments(value: unknown, identity: unknown): void {
  const bytes =
    (typeof value === "string" ? Buffer.byteLength(value) : 0) +
    (typeof identity === "string" ? Buffer.byteLength(identity) : 0);
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
