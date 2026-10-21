/** Keep reentrant native-call mutations bound to their current owner (PRD §4). */
export class CandidateAuthority {
  private readonly active = new Map<string, object>();

  run(callId: string, operation: (authority: object) => boolean): boolean {
    const authority = {};
    this.active.set(callId, authority);
    try {
      return operation(authority);
    } finally {
      if (this.isCurrent(callId, authority)) this.active.delete(callId);
    }
  }

  isCurrent(callId: string, authority: object): boolean {
    return this.active.get(callId) === authority;
  }

  supersede(callId: unknown): void {
    if (typeof callId === "string") this.active.delete(callId);
  }
}
