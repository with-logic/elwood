/** Same-process launch ownership for shared session state (PRD §8.1, C-API-20). */
type Phase = "active" | "pending" | "failed";
type Entry = { readonly path: string; readonly generation: WeakRef<Generation> };
const generations = new Map<string, Entry>();
const collected = new FinalizationRegistry<Entry>((entry) => {
  if (generations.get(entry.path) === entry) generations.delete(entry.path);
});

class Generation {
  readonly entry: Entry;
  phase: Phase;
  previous: Generation | undefined;
  constructor(path: string, phase: Phase) {
    this.entry = { path, generation: new WeakRef(this) };
    this.phase = phase;
    this.previous = generations.get(path)?.generation.deref();
  }
}

export type LaunchOwnership = {
  readonly current: () => boolean;
  readonly canPersist: () => boolean;
  readonly release: () => void;
};
export type LaunchReservation = LaunchOwnership & {
  readonly commit: () => void;
  readonly rollback: () => void;
};

function reserve(path: string, phase: Phase): LaunchReservation {
  const token = new Generation(path, phase);
  generations.set(path, token.entry);
  collected.register(token, token.entry, token);
  const current = () => generations.get(path) === token.entry;
  return {
    current,
    canPersist: () => {
      if (token.phase === "failed") return false;
      let owner = generations.get(path)?.generation.deref();
      while (owner) {
        if (owner === token) return true;
        if (owner.phase === "active") return false;
        owner = owner.previous;
      }
      return false;
    },
    release: () => {
      if (current()) {
        generations.delete(path);
        collected.unregister(token);
      }
    },
    commit: () => {
      token.phase = "active";
      token.previous = undefined;
    },
    rollback: () => {
      token.phase = "failed";
      if (current()) {
        let previous = token.previous;
        while (previous?.phase === "failed") previous = previous.previous;
        if (previous) generations.set(path, previous.entry);
        else generations.delete(path);
      }
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
