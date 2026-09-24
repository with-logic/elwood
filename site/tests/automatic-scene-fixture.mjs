/** Real automatic scene, World and shared-bank boundaries (PRD §13). */
import { LandingScene } from "../landing-scene.mjs";
import { fixture, turn } from "./animation-fixture.mjs";
export { turn };
export async function automaticScene(t) {
  const assets = fixture(t);
  const keys = ["document", "matchMedia", "devicePixelRatio", "requestAnimationFrame", "cancelAnimationFrame"];
  const original = Object.fromEntries(keys.map((key) => [key, globalThis[key]]));
  const context = new Proxy({}, { get: () => () => {} });
  const canvas = () => ({ getContext: () => context });
  Object.assign(globalThis, { document: { createElement: canvas }, matchMedia: () => ({ matches: false }),
    devicePixelRatio: 1, requestAnimationFrame: () => 1, cancelAnimationFrame() {} });
  const scene = new LandingScene(canvas(), { onError: (error) => assets.errors.push(error) });
  scene.bank.dispose();
  scene.bank = assets.bank;
  scene.ready = true;
  scene.visibleBounds = { left: 20, right: 1000 };
  scene.world.clips = Object.fromEntries(["idle", "rotation", "wave", "bow", "cartwheel"].map(name => [name, { frames: name === "wave" ? 6 : 2, fps: 24 }]));
  await scene.bank.prepare("idle");
  t.after(() => { scene.dispose(); Object.assign(globalThis, original); });
  const tick = async (count = 1, dt = 1 / 120) => {
    for (let i = 0; i < count; i++) { scene.step(dt); await turn(); }
  };
  return { ...assets, scene, tick };
}
export const moment = (name = "wave") => ({ kind: "moment", name, sent: false, seen: false, elapsed: 0, hold: 3 });
