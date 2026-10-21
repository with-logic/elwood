/** Observe cancellation and retry native response cleanup before private files are removed (PRD §9). */
import type { CodexSessionApi } from "../../src/index.ts";

/** Attach a handler immediately, retaining the original promise for cleanup diagnostics. */
export function trackResponseKill(
  session: Pick<CodexSessionApi, "kill"> | undefined,
  attempts: Promise<void>[],
): void {
  const attempt = session?.kill();
  if (!attempt) return;
  void attempt.catch(() => undefined);
  attempts.push(attempt);
}

export async function closeNativeResponse(
  close: () => Promise<void>,
  session: Pick<CodexSessionApi, "teardown"> | undefined,
  attempts: readonly Promise<void>[],
): Promise<void> {
  const failures: unknown[] = [];
  try {
    await close();
  } catch (error) {
    failures.push(error);
    try {
      await session?.teardown();
    } catch (error) {
      failures.push(error);
    }
  }
  for (const result of await Promise.allSettled(attempts)) {
    if (result.status === "rejected") failures.push(result.reason);
  }
  if (failures.length) throw new AggregateError(failures, "Native response cleanup failed");
}
