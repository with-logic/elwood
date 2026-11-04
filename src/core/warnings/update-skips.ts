/** Shared no-attempt skip reasons for warning, cache and lease policy (PRD §9.2, C-LIFE-11). */

/** Contention waits for the active owner; pending cleanup skips immediately. Neither ran locally. */
export const updateSkipMessages = {
  active_owner: "another updater is still active",
  cleanup_pending: "another updater's process group has not exited",
} as const;

export type UpdateSkipReason = keyof typeof updateSkipMessages;

/** Unknown error details count as a skip reason only when this shared table owns the key. */
export function isUpdateSkipReason(value: unknown): value is UpdateSkipReason {
  return typeof value === "string" && Object.hasOwn(updateSkipMessages, value);
}
