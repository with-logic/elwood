/** Private confirmed Stop and classified rendered outcomes (PRD §5.8, C-API-48). */
import type { BoundarySignal } from "./boundary-signal.ts";
export type NativeBoundary =
  | {
      readonly kind: "stop";
      readonly turnId: string | undefined;
      readonly signal: BoundarySignal;
    }
  | { readonly kind: "rendered" };
type Observer = (boundary: NativeBoundary) => void;
const observers = new WeakMap<object, Set<Observer>>();

export function onNativeBoundary(session: object, observer: Observer): () => void {
  let current = observers.get(session);
  if (!current) {
    current = new Set();
    observers.set(session, current);
  }
  current.add(observer);
  return () => {
    current.delete(observer);
  };
}

/** Stop follows an unblocked callback; rendered completion comes only from the turn watcher. */
export function confirmNativeBoundary(session: object, boundary: NativeBoundary): void {
  for (const observer of observers.get(session) ?? []) observer(boundary);
}
