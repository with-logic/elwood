/** Bound native candidate identities and publication state for PRD §4 adapters. */
import { QuestionNotificationErrors } from "../../core/questions/notification-errors.ts";
import type { QuestionRegistry } from "../../core/questions/registry.ts";
import type { QuestionCloseReason } from "../../core/questions/types.ts";
import {
  type AcceptedQueuedCandidate,
  availableAcceptedQueuedSnapshot,
  type Candidate,
  candidateGroups,
  createCandidate,
  type QueuedCandidate,
} from "./candidate.ts";
import { candidateCallAccepted } from "./candidate-acceptance.ts";
import { CandidateAuthority } from "./candidate-authority.ts";
import { publishCandidateRequest } from "./candidate-publication.ts";
import { QuestionBudget } from "./limits.ts";
import type { QuestionCall } from "./records.ts";

export type { Candidate } from "./candidate.ts";

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };

export class CandidateStore {
  private readonly records = new Map<string, Mutable<Candidate>>();
  /** Live readonly catalog; candidate object identity survives acceptance/publication. */
  get candidates(): ReadonlyMap<string, Candidate> {
    return this.records;
  }
  private readonly unpublished = new Set<Candidate>();
  private accepted: readonly AcceptedQueuedCandidate[] | undefined;
  private readonly budget = new QuestionBudget();
  private readonly notifications = new QuestionNotificationErrors();
  protected disabled = false;
  protected mutationEpoch = 0;
  private opaqueReservation = false;
  protected readonly authority = new CandidateAuthority();
  private readonly registry: QuestionRegistry;
  private readonly onDisabled: (() => void) | undefined;
  constructor(registry: QuestionRegistry, onDisabled?: () => void) {
    this.registry = registry;
    this.onDisabled = onDisabled;
  }
  /** Defer known registry observer failures until independent native work finishes. */
  batchNotifications<T>(operation: () => T): T {
    return this.notifications.run(operation);
  }
  /** Includes both opaque holds and parsed native candidates. */
  hasReservation(): boolean {
    return this.opaqueReservation || this.candidates.size > 0;
  }
  hasOpaqueReservation(): boolean {
    return this.opaqueReservation;
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
  /** Cached, frozen membership snapshot. Entries are live readonly candidate views. */
  availableAcceptedQueuedCandidates(): readonly AcceptedQueuedCandidate[] {
    this.accepted ??= availableAcceptedQueuedSnapshot(this.candidates.values());
    return this.accepted;
  }
  /** Live readonly membership view; publication and closure remove entries immediately. */
  unpublishedCandidates(): ReadonlySet<Candidate> {
    return this.unpublished;
  }
  /** Ignore stale candidate objects after replacement or closure. */
  setSubmitting(candidate: Candidate, value: boolean): void {
    const record = this.records.get(candidate.nativeKey);
    if (record === candidate) record.submitting = value;
  }
  markPendingSubmission(candidate: Candidate): void {
    const record = this.records.get(candidate.nativeKey);
    if (record !== candidate) return;
    record.hasPendingNativeSubmission = true;
    this.accepted = undefined;
  }
  protected accept(candidate: Mutable<QueuedCandidate>): boolean {
    if (candidate.accepted) return false;
    candidate.accepted = true;
    this.accepted = undefined;
    return true;
  }
  protected reconcileCallCandidates(call: QuestionCall): boolean {
    return this.authority.run(call.callId, (authority) => this.replaceCall(call, authority));
  }
  private replaceCall(call: QuestionCall, authority: object): boolean {
    const mutationEpoch = this.mutationEpoch;
    const accepted = candidateCallAccepted(call, this.candidates);
    const groups = candidateGroups(call);
    let changed = this.retireRemoved(call.callId, groups, authority, mutationEpoch);
    for (const group of groups) {
      if (!this.ownsCall(call.callId, authority, mutationEpoch)) return true;
      if (this.budget.hasRetired(group.nativeKey)) continue;
      const existing = this.records.get(group.nativeKey);
      if (existing && JSON.stringify(existing.questions) === JSON.stringify(group.questions)) {
        if (existing.queued && accepted) changed = this.accept(existing) || changed;
        continue;
      }
      const bytes = Buffer.byteLength(
        JSON.stringify([group.nativeKey, call.callId, group.questions]),
      );
      this.budget.replace(
        this.candidates.size + (existing ? 0 : 1),
        bytes - (existing?.bytes ?? 0),
      );
      const candidate: Mutable<Candidate> = createCandidate(group, call.callId, accepted, bytes);
      if (existing) this.unpublished.delete(existing);
      this.records.set(group.nativeKey, candidate);
      this.unpublished.add(candidate);
      this.accepted = undefined;
      changed = true;
      const previous = this.registry.find(group.nativeKey);
      if (previous) this.closeRequest(previous.id, "unavailable");
    }
    return changed;
  }
  private ownsCall(callId: string, authority: object, epoch: number): boolean {
    return this.mutationEpoch === epoch && this.authority.isCurrent(callId, authority);
  }
  private retireRemoved(
    callId: string,
    groups: readonly { readonly nativeKey: string }[],
    authority: object,
    epoch: number,
  ): boolean {
    let changed = false;
    const keys = new Set(groups.map((group) => group.nativeKey));
    for (const candidate of this.candidates.values()) {
      if (!this.ownsCall(callId, authority, epoch)) return true;
      if (candidate.callId === callId && !keys.has(candidate.nativeKey)) {
        this.close(candidate.nativeKey, "unavailable");
        changed = true;
      }
    }
    return changed;
  }
  publish(candidate: Candidate): void {
    this.batchNotifications(() => {
      if (!this.unpublished.has(candidate)) return;
      const record = this.records.get(candidate.nativeKey)!;
      record.published = publishCandidateRequest(this.registry, this.notifications, candidate);
      if (record.published) this.unpublished.delete(candidate);
    });
  }
  /** Tombstone even missing identities to prevent replay; false means no active candidate closed. */
  close(nativeKey: string, reason: QuestionCloseReason): boolean {
    return this.batchNotifications(() => this.closeCandidate(nativeKey, reason));
  }
  private closeCandidate(nativeKey: string, reason: QuestionCloseReason): boolean {
    if (this.disabled) return false;
    try {
      this.budget.retire(nativeKey);
    } catch {
      return this.disable();
    }
    const candidate = this.candidates.get(nativeKey);
    if (!candidate) return false;
    this.budget.replace(this.candidates.size, -candidate.bytes);
    this.records.delete(nativeKey);
    this.unpublished.delete(candidate);
    this.accepted = undefined;
    const request = this.registry.find(nativeKey);
    if (request) this.closeRequest(request.id, reason);
    return true;
  }
  protected disable(): boolean {
    this.mutationEpoch += 1;
    this.disabled = true;
    this.reserveOpaqueReservation();
    const keys = [...this.candidates.keys()];
    this.records.clear();
    this.unpublished.clear();
    this.accepted = undefined;
    this.budget.clear();
    for (const nativeKey of keys) {
      const request = this.registry.find(nativeKey);
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
    this.notifications.capture(() => this.registry.close(id, reason));
  }
}
