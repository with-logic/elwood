# Chaining Elwood’s actions

`World.update(dt, input)` is the action interface used by the keyboard controller. It accepts one-shot requests (`gesture`, `face`, `jumpPressed`, `climbPressed`, `dropPressed`, `releaseGesture`) and continuous movement (`axis`, from -1 to 1). A future scheduler can supply the same inputs and choose its own delays; the playground currently remains under manual control.

Each gesture has a source frame clock, independent of render refresh. The loaded manifest describes frame counts, source cadence, orientation, and optional `hold_frame`, `hold_loop`, `hold_loop_seconds`, `finish_before_next` and `travel_speed` data. The controller exposes `player.gesture`, `player.gestureStage`, `player.gestureElapsed`, `player.gestureDirection`, `player.queuedAction`, and the ordinary movement state.

## Enter, hold, recover

Crossed arms holds frame 94 of its 144-frame clip. Cross-legged sitting holds frame 137 of its 240-frame clip. Faint holds frame 101 of its 144-frame clip, while lying on the floor. These are reviewed middle poses immediately before the source recovery. Float uses `hold_loop: [60, 80]` to hover forward and backward using only reviewed bent-knee poses. The loop, entrance and landing all run at normal source speed (24 fps). The loop takes about 1.67 seconds per forward/reverse cycle; no duration override is configured.

1. Request the gesture once. The controller rotates to its entry orientation and plays the entrance.
2. At the configured hold frame, `gestureStage` becomes `hold`. The frame clock stays there for any length of time. For a `hold_loop`, it instead bounces between the two boundary frames; `gestureDirection` tracks forward or reverse playback. Neither hold has an automatic timeout.
3. Request another gesture, facing direction, jump, movement, climb or drop. The held action enters `exit` and continues forward from the currently displayed image, including when the hover was running backward, through the remaining recovery. Position and facing stay fixed during that recovery.
4. The queued discrete request begins after recovery. A later request replaces the earlier one. Movement uses the currently held direction, so releasing the movement key during recovery does not leave a stale walking command.

Selecting the same held gesture again, or sending `releaseGesture: true`, releases it without choosing another action and clears any queued request. Reset clears the hold and all pending requests immediately. Jump presses survive the recovery and any following orientation change.

```js
// Send each request once, then keep ticking with an empty input or held axis.
world.update(dt, { gesture: 'criss-cross' });
world.update(dt, {});

// A future scheduler can start its variable delay when this becomes true:
const settled = world.player.gestureStage === 'hold';

// After its chosen delay, this queues the wave behind the stand-up recovery.
world.update(dt, { gesture: 'wave' });
```

Gestures without a hold point play once and then rest at the available rotation pose nearest their final orientation. The controller does not send them back to a left/right idle. A later action rotates from that saved angle to its own entry pose. Other one-shot gestures can still be interrupted immediately by movement, except clips marked `finish_before_next`. Cartwheel, arm inspection, punch jump, faint and float use that flag: they complete their recorded recovery before a queued action. This prevents an airborne pose or detached arm from being replaced mid-performance. Faint and float additionally have indefinite holds; the others play once. Reset bypasses recovery. Toe touch plays at 1.5× source speed; shrug and peace sign play at 2×.

## Motion and asset constraints

Pond hops retain the source video’s vertical motion. Their exported `travel_speed` array is zero on planted frames and rises to 52 world pixels/second while airborne, totaling about 50 pixels per performance. This is grounded sprite travel, not an additional physics jump; it stops at solid platform sides. Walking and tiptoe keep their separate measured speeds.

Cartwheel retains a fixed source origin and floor, with an exported `travel_speed` array canceling the measured backward floor-contact sweep. `ground-motion.json` records the offline trajectory from actual 4K cutouts; gameplay adds about 102.5 world pixels in the facing direction and preserves that position on completion. Its source clock and travel both pause when a needed image page is unavailable. Solid platform sides still constrain travel.

Punch jump, faint and float retain a fixed source origin and floor without added horizontal travel or a physics jump. These decorative jumps are separate from the navigational Space jump. Moonwalk is retired from the action set and keyboard.

Arm inspection uses 133 frames: source 0–60, 12 extra copies of frame 60 for a half-second pause, then source 59–0. This avoids the original take’s confused scratching motion and returns through the same clean removal poses.

The front rotation uses one continuous left-to-front source sweep and its reflection for the other half. It no longer joins the source take’s ending pose to its beginning. Rear views retain their separate reviewed quarter-turn. Source pose blends remain short and use premultiplied alpha, with the tether aligned to the same tracked socket in both images.

`SpriteBank.prepare(name)` loads metadata and the entry page for callers that only need a starting pose. Gesture callers must use `SpriteBank.prepareAnimation(name)` before requesting playback; it prepares every page in the clip so the animation cannot pause for asset loading. The page controller owns and cancels stale asynchronous requests. Static held poses need one current image page, while the hover keeps its complete clip available. Both use the reduced resting paint cadence. Full source clips, 4K videos, native PNGs and the archive sprite player remain independent of the game’s hold behavior.

## Keyboard

The page exposes all 28 emotes on labeled, clickable QWERTY keys. Each has one `data-code` matching a physical key; no Shift combinations are required. Movement, facing, pause and reset occupy their existing keys. Virtual movement supports pointer presses and focused Space/Enter activation, releasing on pointer cancellation, keyup or blur. The page still prepares each requested gesture lazily and ignores stale loading requests.
