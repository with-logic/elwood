/** Native output progress plus current idle evidence for one physical attempt (PRD §5.8). */
type IdleSource = {
  readonly capture: () => { readonly isIdle: () => boolean; readonly isReady: () => boolean };
  readonly subscribe: (listener: () => void) => () => void;
};
const sources = new WeakMap<object, IdleSource>();

export function registerNativeIdle(session: object, source: IdleSource): void {
  sources.set(session, source);
}

/** Capture before Enter; queued old output and geometry-only changes never qualify. */
export function captureNativeIdle(session: object) {
  const source = sources.get(session);
  if (!source) return undefined;
  const { isIdle, isReady } = source.capture();
  return {
    isIdle,
    isReady,
    onIdle: (listener: () => void) => {
      const off = source.subscribe(() => {
        if (!isIdle()) return;
        off();
        listener();
      });
      return off;
    },
  };
}
