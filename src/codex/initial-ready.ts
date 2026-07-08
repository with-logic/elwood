/**
 * Codex first terminal-frame readiness marker with a starvation deadline.
 * Implements PRD §5.3, C-API-19, and C-API-28.
 */

export type InitialReady = {
  readonly cancel: () => void;
  readonly replay: () => void;
  readonly schedule: () => void;
  readonly armDeadline: () => void;
};

export function initialReady(
  callback: () => void,
  delayMs = 250,
  maxWaitMs = 10_000,
): InitialReady {
  let ready = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const mark = () => {
    if (ready) return;
    ready = true;
    callback();
  };
  const cancel = () => {
    if (timer) clearTimeout(timer);
    if (deadline) clearTimeout(deadline);
  };
  return {
    cancel,
    replay: () => void (ready && callback()),
    // The deadline arms on the first frame regardless of composer detection,
    // so continuous animation or renderer drift cannot starve readiness.
    armDeadline: () => {
      deadline ??= setTimeout(mark, maxWaitMs);
    },
    schedule: () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(mark, delayMs);
      deadline ??= setTimeout(mark, maxWaitMs);
    },
  };
}
