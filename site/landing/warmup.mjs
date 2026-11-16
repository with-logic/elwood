/** Loads the clips a visitor reaches first before they are asked for (PRD §13.5; docs/design/landing.md). */

/** Every first movement needs these. On the twelve-sheet cache they fit beside idle and the
 * suspended pickup; the six-sheet cache keeps as many as fit, in this order.
 */
export const DECODED_AHEAD = Object.freeze([
  "rotation", "walk-right", "walk-left", "idle-right", "idle-left", "land", "land-rest", "jump",
]);
/** Larger or rarer: downloaded and held by the bank, decoded only when intent appears. */
export const DOWNLOADED_AHEAD = Object.freeze([
  "pickup-wriggle", "hero-land", "pickup-fall", "run", "idle-front", "idle-back",
]);

/** Start after the first live paint. Abort the returned controller on teardown. */
export function warmLanding(scene, connection = globalThis.navigator?.connection) {
  const controller = new AbortController();
  // Visitors who asked for less data or less motion load nothing ahead at the handoff.
  // Browsers that expose no data-saving signal (Safari, Firefox) load ahead.
  if (connection?.saveData || scene.reduced) return controller;
  scene.warm(DECODED_AHEAD, { keep: true });
  (async () => {
    for (const name of DOWNLOADED_AHEAD) {
      if (!scene.world.clips[name]) continue;
      // Speculative work reports nothing; the bank reports a real failure when the clip is used.
      await scene.bank.downloads.download(name, controller.signal).catch(() => {});
      if (controller.signal.aborted) return;
    }
  })();
  return controller;
}

/** Hovering or focusing the robot decodes the suspended pickup clip before the press arrives.
 * The fall and landing stay download-only until the drag begins: decoded here they would
 * push the movement clips out of the cache.
 */
export function bindPickupIntent(scene, grip) {
  const warm = () => scene.warm([scene.pickupClips().suspended]);
  grip.addEventListener("pointerenter", warm);
  grip.addEventListener("focus", warm);
}
