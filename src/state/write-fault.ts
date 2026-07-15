/**
 * Test-only fault injection for durable record writes (PRD §8 testing seam).
 * Lets a test force selected `writeSessionRecord` calls to throw — the fault
 * inspects the record and throws to fail that write — so persist-failure paths
 * like the C-API-42 initial-ready fallback are exercised without racing the
 * filesystem. The fault is undefined in production and reset between tests.
 */

import type { SessionRecord } from "./store.ts";

let recordWriteFault: ((record: SessionRecord) => void) | undefined;

/** Invoked before every durable record write; throws to fail the selected write. */
export function applyRecordWriteFault(record: SessionRecord): void {
  recordWriteFault?.(record);
}

/** Force selected durable record writes to throw; pass `undefined` to restore. */
export function setRecordWriteFaultForTests(fault: typeof recordWriteFault): void {
  recordWriteFault = fault;
}
