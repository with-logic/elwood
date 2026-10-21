/** Bound native candidate identities and publication state for PRD §4 adapters. */
import type { QuestionRegistry } from "../../core/questions/registry.ts";
import type { QuestionCloseReason } from "../../core/questions/types.ts";
import { type Candidate, candidateGroups } from "./candidate.ts";
import { QuestionBudget } from "./limits.ts";
import type { QuestionCall } from "./records.ts";

export type { Candidate } from "./candidate.ts";

export class CandidateStore {
  readonly candidates = new Map<string, Candidate>();
  private readonly unpublished = new Set<Candidate>();
  private accepted: readonly Candidate[] | undefined;
  private readonly budget = new QuestionBudget();
  protected disabled = false;
  protected mutationEpoch = 0;
  private opaqueReservation = false;
  private readonly registry: QuestionRegistry;
  private readonly onDisabled: (() => void) | undefined;
  constructor(registry: QuestionRegistry, onDisabled?: () => void) {
    this.registry = registry;
    this.onDisabled = onDisabled;
  }
  /** Includes both opaque holds and parsed native candidates. */
  hasReservation(): boolean {
    return this.opaqueReservation || this.candidates.size > 0;
  }
  clearOpaqueReservation(): boolean {
    const changed = this.opaqueReservation;
    this.opaqueReservation = false;
    return changed;
  }
  protected reserveOpaqueReservation(): boolean {
    const changed = !this.opaqueReservation;
    this.opaqueReservation = true;
    return changed;
  }
  acceptedQueuedCandidates(): readonly Candidate[] {
    this.accepted ??= Object.freeze(
      [...this.candidates.values()].filter((candidate) => candidate.queued && candidate.accepted),
    );
    return this.accepted;
  }
  unpublishedCandidates(): ReadonlySet<Candidate> {
    return this.unpublished;
  }
  protected accept(candidate: Candidate): boolean {
    if (candidate.accepted) return false;
    candidate.accepted = true;
    this.accepted = undefined;
    return true;
  }
  protected add(call: QuestionCall): boolean {
    const mutationEpoch = this.mutationEpoch;
    const accepted = this.callAccepted(call);
    const groups = candidateGroups(call);
    let changed = this.retireRemoved(call.callId, groups);
    for (const group of groups) {
      if (this.mutationEpoch !== mutationEpoch) return true;
      if (this.budget.hasRetired(group.key)) continue;
      const existing = this.candidates.get(group.key);
      if (existing && JSON.stringify(existing.questions) === JSON.stringify(group.questions)) {
        if (accepted) changed = this.accept(existing) || changed;
        continue;
      }
      const bytes = Buffer.byteLength(JSON.stringify([group.key, call.callId, group.questions]));
      this.budget.replace(
        this.candidates.size + (existing ? 0 : 1),
        bytes - (existing?.bytes ?? 0),
      );
      const candidate: Candidate = {
        ...group,
        callId: call.callId,
        accepted,
        submitting: false,
        published: false,
        bytes,
      };
      if (existing) this.unpublished.delete(existing);
      this.candidates.set(group.key, candidate);
      this.unpublished.add(candidate);
      this.accepted = undefined;
      changed = true;
      const previous = this.registry.find(group.key);
      if (previous) this.closeRequest(previous.id, "unavailable");
    }
    return changed;
  }
  private callAccepted(call: QuestionCall): boolean {
    return (
      call.accepted ||
      this.candidates
        .values()
        .some((candidate) => candidate.callId === call.callId && candidate.accepted)
    );
  }
  private retireRemoved(callId: string, groups: readonly { readonly key: string }[]): boolean {
    let changed = false;
    const keys = new Set(groups.map((group) => group.key));
    for (const candidate of this.candidates.values()) {
      if (candidate.callId === callId && !keys.has(candidate.key)) {
        this.close(candidate.key, "unavailable");
        changed = true;
      }
    }
    return changed;
  }
  publish(candidate: Candidate): void {
    if (!this.unpublished.has(candidate)) return;
    try {
      this.registry.publish(
        candidate.key,
        candidate.queued ? "queued" : "blocking",
        candidate.questions.map((question) => question.definition),
      );
    } catch {
      // One throwing observer must not suppress independent native question units.
    } finally {
      candidate.published = this.registry.find(candidate.key) !== undefined;
      if (candidate.published) this.unpublished.delete(candidate);
    }
  }
  close(key: string, reason: QuestionCloseReason): boolean {
    if (this.disabled) return false;
    try {
      this.budget.retire(key);
    } catch {
      return this.disable();
    }
    const candidate = this.candidates.get(key);
    if (!candidate) return false;
    this.budget.replace(this.candidates.size, -candidate.bytes);
    this.candidates.delete(key);
    this.unpublished.delete(candidate);
    this.accepted = undefined;
    const request = this.registry.find(key);
    if (request) this.closeRequest(request.id, reason);
    return true;
  }
  protected disable(): boolean {
    this.mutationEpoch += 1;
    this.disabled = true;
    this.reserveOpaqueReservation();
    const keys = [...this.candidates.keys()];
    this.candidates.clear();
    this.unpublished.clear();
    this.accepted = undefined;
    this.budget.clear();
    for (const key of keys) {
      const request = this.registry.find(key);
      if (request) this.closeRequest(request.id, "unavailable");
    }
    try {
      this.onDisabled?.();
    } catch {
      // Diagnostic failure must not interrupt permanent automation disablement.
    }
    return true;
  }
  private closeRequest(id: string, reason: QuestionCloseReason): void {
    try {
      this.registry.close(id, reason);
    } catch {
      // One throwing observer must not strand the remaining native closures.
    }
  }
}
