/** Capture private per-call input evidence before async preparation (PRD §5.8). */
export type SubmissionAttempt = { readonly beforeEnter: (payload: string) => void };
const submissions = new WeakMap<object, SubmissionAttempt>();
const nativeTurns = new WeakMap<object, string>();

/** Read synchronously at queue admission; never inherit this context into callbacks. */
export function submissionAttempt(session: object): SubmissionAttempt | undefined {
  return submissions.get(session);
}

export function withSubmissionAttempt<T>(
  session: object,
  attempt: SubmissionAttempt,
  submit: () => T,
): T {
  const previous = submissions.get(session);
  submissions.set(session, attempt);
  try {
    return submit();
  } finally {
    if (previous) submissions.set(session, previous);
    else submissions.delete(session);
  }
}

/** Retain only the most recently observed authenticated native generation. */
export function recordNativeTurn(session: object, turnId: string): void {
  nativeTurns.set(session, turnId);
}
export function lastNativeTurn(session: object): string | undefined {
  return nativeTurns.get(session);
}

/** Live adapters register their own native acceptance reader for internal loop submissions. */
const nativeReaders = new WeakMap<object, import("./turn-identity.ts").NativeTurnReader>();
export function registerNativeTurnReader(
  session: object,
  reader: import("./turn-identity.ts").NativeTurnReader,
): void {
  nativeReaders.set(session, reader);
}
export function nativeTurnReader(session: object) {
  return nativeReaders.get(session);
}
