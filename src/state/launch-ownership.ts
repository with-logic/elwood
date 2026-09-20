/** Same-process launch ownership for shared session state (PRD §8.1, C-API-20). */
import { elwoodError } from "../core/errors.ts";
import { canonicalStatePath } from "./canonical-path.ts";
import { writePrivateFileAtomic } from "./files.ts";
import { LaunchPublication } from "./launch-publication.ts";

type Phase = "active" | "pending" | "failed";
type Entry = { readonly path: string; readonly generation: WeakRef<Generation> };
const generations = new Map<string, Entry>();
const collected = new FinalizationRegistry<Entry>((entry) => {
  if (generations.get(entry.path) === entry) generations.delete(entry.path);
});

class Generation {
  readonly entry: Entry;
  readonly publication = new LaunchPublication();
  phase: Phase = "pending";
  previous: Generation | undefined;
  readonly settled = Promise.withResolvers<void>();
  readonly activation: (() => void)[] = [];
  readonly revoked: (() => void)[] = [];
  constructor(path: string) {
    this.entry = { path, generation: new WeakRef(this) };
    this.previous = generations.get(path)?.generation.deref();
  }
}

export type LaunchOwnership = {
  /** Exclusive authority for startup publication and destructive cleanup. */
  readonly current: () => boolean;
  /** Ordinary loop and record writes may continue on a predecessor while resume is pending. */
  readonly canPersist: () => boolean;
  readonly persistFile: (path: string, text: string) => void;
  readonly publishFile: (path: string, text: string) => void;
  readonly release: () => void;
  readonly onCommit: (activate: () => void) => void;
  readonly onRevoked: (pause: () => void) => void;
  readonly waitForCleanup: () => Promise<void>;
};
export type LaunchReservation = LaunchOwnership & {
  readonly commit: () => void;
  readonly rollback: () => void;
};

/** Reserve before startup yields; failure restores only the still-current predecessor. */
export function reserveLaunchOwnership(inputPath: string): LaunchReservation {
  const path = canonicalStatePath(inputPath);
  const token = new Generation(path);
  const publication = token.publication;
  generations.set(path, token.entry);
  collected.register(token, token.entry, token);
  const current = () => generations.get(path) === token.entry;
  let retryOwner: Entry | undefined;
  let failedPublications: LaunchPublication[] = [];
  const canPersist = () => {
    if (token.phase === "failed") return false;
    let owner = generations.get(path)?.generation.deref();
    while (owner) {
      if (owner === token) return true;
      if (owner.phase === "active") return false;
      owner = owner.previous;
    }
    return false;
  };
  return {
    current,
    canPersist,
    persistFile: (file, text) => {
      if (!canPersist()) throw elwoodError("session_not_running", "Launch was superseded.");
      if (token.phase === "pending") publication.write(file, text);
      else writePrivateFileAtomic(file, text);
    },
    publishFile: (file, text) => {
      if (!current()) throw elwoodError("session_not_running", "Launch was superseded.");
      if (token.phase === "pending") publication.write(file, text);
      else writePrivateFileAtomic(file, text);
    },
    onCommit: (activate) => {
      token.activation.push(activate);
    },
    onRevoked: (pause) => {
      token.revoked.push(pause);
    },
    waitForCleanup: async () => {
      let owner = generations.get(path)?.generation.deref();
      while (owner && owner !== token && owner.phase === "pending") {
        await owner.settled.promise;
        owner = generations.get(path)?.generation.deref();
      }
    },
    release: () => {
      if (current()) {
        generations.delete(path);
        collected.unregister(token);
        token.settled.resolve();
      }
    },
    commit: () => {
      if (!canPersist()) throw elwoodError("session_not_running", "Launch was superseded.");
      // Activation rereads durable loops synchronously before ownership changes.
      for (const activate of token.activation) activate();
      publication.clear();
      token.phase = "active";
      let previous = token.previous;
      token.previous = undefined;
      while (previous) {
        for (const pause of previous.revoked) pause();
        previous = previous.previous;
      }
      token.settled.resolve();
    },
    rollback: () => {
      if (token.phase === "failed") {
        if (retryOwner && generations.get(path) === retryOwner) restoreAll(failedPublications);
        return;
      }
      try {
        if (current()) {
          let previous = token.previous;
          failedPublications = [publication];
          while (previous?.phase === "failed") {
            failedPublications.push(previous.publication);
            previous = previous.previous;
          }
          retryOwner = previous?.entry;
          try {
            restoreAll(failedPublications);
          } finally {
            if (previous) generations.set(path, previous.entry);
            else generations.delete(path);
          }
        }
      } finally {
        token.phase = "failed";
        collected.unregister(token);
        token.settled.resolve();
      }
    },
  };
}

/** CLI identity cleanup cannot remove a live or pending same-process launch's state. */
export function hasLaunchOwner(sessionDir: string): boolean {
  return generations.get(canonicalStatePath(sessionDir))?.generation.deref() !== undefined;
}

function restoreAll(publications: readonly LaunchPublication[]): void {
  let failure: unknown;
  for (const publication of publications) {
    try {
      publication.rollback();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
}
