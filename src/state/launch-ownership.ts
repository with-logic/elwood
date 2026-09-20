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
  phase: Phase;
  previous: Generation | undefined;
  constructor(path: string, phase: Phase) {
    this.entry = { path, generation: new WeakRef(this) };
    this.phase = phase;
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
};
export type LaunchReservation = LaunchOwnership & {
  readonly commit: () => void;
  readonly rollback: () => void;
};

function reserve(inputPath: string, phase: Phase): LaunchReservation {
  const path = canonicalStatePath(inputPath);
  const token = new Generation(path, phase);
  const publication = token.publication;
  generations.set(path, token.entry);
  collected.register(token, token.entry, token);
  const current = () => generations.get(path) === token.entry;
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
    release: () => {
      if (current()) {
        generations.delete(path);
        collected.unregister(token);
      }
    },
    commit: () => {
      publication.clear();
      token.phase = "active";
      token.previous = undefined;
    },
    rollback: () => {
      if (current()) publication.rollback();
      if (current()) {
        let previous = token.previous;
        while (previous?.phase === "failed") {
          previous.publication.rollback();
          previous = previous.previous;
        }
        if (previous) generations.set(path, previous.entry);
        else generations.delete(path);
      }
      token.phase = "failed";
      collected.unregister(token);
    },
  };
}

/** Fresh starts own state immediately; a stopped object's authority stays weakly registered. */
export function claimLaunchOwnership(sessionDir: string): LaunchOwnership {
  const ownership = reserve(sessionDir, "active");
  ownership.commit();
  return ownership;
}

/** Reserve before resume yields; failure restores only the still-current predecessor. */
export function reserveLaunchOwnership(sessionDir: string): LaunchReservation {
  return reserve(sessionDir, "pending");
}

/** CLI identity cleanup cannot remove a live or pending same-process launch's state. */
export function hasLaunchOwner(sessionDir: string): boolean {
  return generations.get(canonicalStatePath(sessionDir))?.generation.deref() !== undefined;
}
