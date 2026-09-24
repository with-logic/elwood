/** Real scene, World and bank boundaries for explicit controls (PRD §13). */
import { NO_INPUT } from "../autonomy.mjs";
import { LandingScene } from "../landing-scene.mjs";
import { World } from "../world.mjs";
import { fixture } from "./animation-fixture.mjs";

export function sceneFixture(t) {
  const assets = fixture(t), scene = Object.create(LandingScene.prototype);
  Object.assign(scene, {
    bank: assets.bank, world: new World(), ready: true, requestVersion: 0,
    pressed: NO_INPUT, axis: 0, climbHeld: false, sprint: false, pauses: new Set(),
    director: { interact() {}, update() { return NO_INPUT; } }, start() {},
    onError(error) { assets.errors.push(error); },
  });
  scene.world.canRender = (name, index) => !!assets.bank.frame(name, index);
  return { ...assets, scene };
}
