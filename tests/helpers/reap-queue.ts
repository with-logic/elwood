/** Shared serialized signal queue for injected recovery tests (C-LIFE-10). */
import { type ReapQueue, SerialDetachedSweepQueue } from "../../src/runtime/shutdown/reap-queue.ts";

export function serializedReapQueue(): ReapQueue {
  const queue = new SerialDetachedSweepQueue();
  return (attempt) => queue.run(attempt);
}
