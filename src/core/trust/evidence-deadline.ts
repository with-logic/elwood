/** Bound optional native workspace proof without blocking session startup (PRD §5.5). */

// Allow routine local metadata reads while limiting how long optional proof can delay launch.
const trustEvidenceWaitMs = 500;

/** Signal the collector on expiry so it stops issuing reads. Native calls in flight may finish later. */
export async function boundedTrustEvidence<T>(
  collect: (signal: AbortSignal) => Promise<T>,
  cancellation?: AbortSignal,
): Promise<T | undefined> {
  if (cancellation?.aborted) return undefined;
  const stop = new AbortController();
  const expired = Promise.withResolvers<undefined>();
  const expire = () => {
    // Publish expiry first so an abort listener's rejection cannot win the race.
    expired.resolve(undefined);
    stop.abort();
  };
  const timer = setTimeout(expire, trustEvidenceWaitMs);
  cancellation?.addEventListener("abort", expire, { once: true });
  try {
    return await Promise.race([collect(stop.signal), expired.promise]);
  } finally {
    clearTimeout(timer);
    cancellation?.removeEventListener("abort", expire);
  }
}
