/** Same-process launch ownership for shared session state (PRD §8.1, C-API-20). */
type Entry = { readonly path: string; readonly generation: WeakRef<object> };
const generations = new Map<string, WeakRef<object>>();
const collected = new FinalizationRegistry<Entry>(({ path, generation }) => {
  if (generations.get(path) === generation) generations.delete(path);
});

export type LaunchOwnership = {
  readonly current: () => boolean;
  readonly release: () => void;
};

/** Claim immediately before a launch writes its shared runtime files. */
export function claimLaunchOwnership(sessionDir: string): LaunchOwnership {
  const token = {};
  const generation = new WeakRef(token);
  generations.set(sessionDir, generation);
  collected.register(token, { path: sessionDir, generation }, token);
  const current = () => generations.get(sessionDir)?.deref() === token;
  return {
    current,
    release: () => {
      if (current()) generations.delete(sessionDir);
      collected.unregister(token);
    },
  };
}

/** Validated resume revokes old writes before preflight can yield or fail. */
export function revokeLaunchOwnership(sessionDir: string): void {
  generations.delete(sessionDir);
}
