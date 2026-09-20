/** Prevent inherited then/toJSON execution on internal hook envelopes (PRD §6.3–6.4). */
export function inertRecord<T extends object>(record: T): T {
  Object.setPrototypeOf(record, null);
  return record;
}
