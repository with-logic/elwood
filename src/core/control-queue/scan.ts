/** Reuse a blocked queue prefix while dispatch eligibility stays unchanged (PRD §5.3/§5.9). */
export class QueueScanCursor {
  private blockedPrefixLength = 0;

  reset(): void {
    this.blockedPrefixLength = 0;
  }

  /** Removing a crossing operation does not invalidate the prefix before it. */
  removed(index: number): void {
    if (index < this.blockedPrefixLength) this.reset();
  }

  /** Call reset when eligibility changes; appends can keep the scanned prefix. */
  findIndex<T>(queue: readonly T[], eligible: (operation: T) => boolean): number {
    for (let index = this.blockedPrefixLength; index < queue.length; index += 1) {
      if (eligible(queue[index] as T)) {
        this.blockedPrefixLength = index;
        return index;
      }
    }
    this.blockedPrefixLength = queue.length;
    return -1;
  }
}
