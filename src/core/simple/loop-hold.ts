/** Private runtime registration for ergonomic loop isolation (PRD §5.8/§5.9). */
type HoldLoops = () => () => void;
const sessionLoopHolds = new WeakMap<object, HoldLoops>();

export function registerTurnLoopHold(session: object, hold: HoldLoops): void {
  sessionLoopHolds.set(session, hold);
}

/** Custom turn-session implementations without scheduled loops need no hold. */
export function holdTurnLoops(session: object): () => void {
  return sessionLoopHolds.get(session)?.() ?? (() => undefined);
}
