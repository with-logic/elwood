/** Private prerequisite-verification provenance for PRD §9.2 / C-LIFE-09/11. */
export class UpdateVerificationFailure {
  readonly error: unknown;
  /** Set only after uncontended ownership, no recorded prior outcome, and completed probe cleanup. */
  uncontended = false;
  constructor(error: unknown) {
    this.error = error;
  }
}

/** Any resolved verification permits invocation; only its rejection proves no attempt. */
export async function verifyBeforeUpdate(
  verify: () => Promise<unknown>,
  update: () => Promise<void>,
): Promise<void> {
  try {
    await verify();
  } catch (error) {
    throw new UpdateVerificationFailure(error);
  }
  await update();
}
