/** Reuse a blocked queue prefix while dispatch eligibility stays unchanged (PRD §5.3/§5.9). */
export class QueueScanCursor {
  private blockedThrough = 0;

  reset(): void {
    this.blockedThrough = 0;
  }

  /** Removing a crossing operation does not invalidate the prefix before it. */
  removed(index: number): void {
    if (index < this.blockedThrough) this.reset();
  }

  /** Call reset when eligibility changes; appends can keep the scanned prefix. */
  findIndex<T>(queue: readonly T[], eligible: (operation: T) => boolean): number {
    for (let index = this.blockedThrough; index < queue.length; index += 1) {
      if (eligible(queue[index] as T)) {
        this.blockedThrough = index;
        return index;
      }
    }
    this.blockedThrough = queue.length;
    return -1;
  }
}
