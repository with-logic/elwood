/**
 * Public recurring-loop requests, snapshots, and event variants.
 * Implements PRD §5.9 and C-LOOP-02/C-LOOP-10.
 */

export type ElwoodLoopRequest =
  | {
      readonly mode: "fixed";
      readonly intervalMs: number;
      readonly message: string;
    }
  | {
      readonly mode: "idle";
      readonly message: string;
    };

export type ElwoodLoopState = "waiting" | "scheduled" | "due" | "submitted";

export interface ElwoodLoopSnapshot {
  readonly id: string;
  readonly message: string;
  readonly mode: "fixed" | "idle";
  readonly intervalMs?: number;
  readonly jitterMs: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly state: ElwoodLoopState;
  readonly nextDueAt?: number;
}

export type ElwoodLoopEventSnapshot = Omit<ElwoodLoopSnapshot, "message">;

export type ElwoodLoopEvent =
  | {
      readonly kind: "created";
      readonly loopId: string;
      readonly at: number;
      readonly snapshot: ElwoodLoopEventSnapshot;
    }
  | {
      readonly kind: "fired";
      readonly loopId: string;
      readonly scheduledDueAt: number;
      readonly submittedAt: number;
      readonly snapshot: ElwoodLoopEventSnapshot & { readonly state: "submitted" };
    }
  | {
      readonly kind: "cancelled";
      readonly loopId: string;
      readonly at: number;
      readonly reason: "caller" | "kill" | "teardown";
    }
  | {
      readonly kind: "expired";
      readonly loopId: string;
      readonly at: number;
    }
  | {
      readonly kind: "failed";
      readonly loopId: string;
      readonly at: number;
      readonly phase: "persistence" | "scheduling" | "submission";
      readonly snapshot?: ElwoodLoopEventSnapshot;
      readonly code: "loop_persistence_failed" | "loop_submission_failed";
      readonly message: string;
    };
