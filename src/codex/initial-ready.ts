/**
 * Codex first terminal-frame readiness marker.
 * Implements PRD §5.3 and C-API-19.
 */

export type InitialReady = {
  readonly cancel: () => void;
  readonly replay: () => void;
  readonly schedule: () => void;
};

export function initialReady(callback: () => void, delayMs = 250): InitialReady {
  let ready = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const mark = () => {
    if (ready) return;
    ready = true;
    callback();
  };
  const cancel = () => {
    if (timer) clearTimeout(timer);
  };
  return {
    cancel,
    replay: () => void (ready && callback()),
    schedule: () => {
      cancel();
      timer = setTimeout(mark, delayMs);
    },
  };
}
