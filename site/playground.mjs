/** Manual animation workshop rendering and lifecycle (PRD §13; docs/design/landing.md). */
import { gameAssetUrl } from "./game-assets.mjs";
import { SpriteBank } from "./sprite-bank.mjs";
import { blendAtSocket, positionPose, samePoseImage, transitionPose } from "./sprite-pose.mjs";
import { SpriteRenderer } from "./sprite-renderer.mjs";
import { FLOOR, HEIGHT, WORLD_WIDTH, World } from "./world.mjs";

const canvas = document.querySelector("#world");
const context = canvas.getContext("2d", { alpha: false });
const spriteRenderer = new SpriteRenderer(context, document.createElement("canvas"));
const world = new World();
const keys = new Set();
const keyCodes = new Set();
const pressed = {};
const loading = document.querySelector("#loading");
const stateLabel = document.querySelector("#state");
const hint = document.querySelector("#hint");
const sceneTitle = document.querySelector(".scene-title");
const gestureButtons = [...document.querySelectorAll("[data-gesture]")];
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
let ready = false;
let paused = false;
let lastTime = 0;
let accumulator = 0;
let raf = 0;
let paintElapsed = 0;
let camera = 0;
let zoom = 1;
let viewportWidth = 1000;
let lastPose = null;
let transition = null;
let animationName = "";
let gestureRequest = 0;
let lastStatus = "";
const handleSpriteError = (error) => {
  stateLabel.textContent = error.message;
};
const bank = new SpriteBank(handleSpriteError);
world.canRender = (name, index) => !!bank.frame(name, index);
const staticScene = document.createElement("canvas");
staticScene.width = WORLD_WIDTH;
staticScene.height = 720;
const background = staticScene.getContext("2d");

function roundRect(ctx, x, y, w, h, radius, fill, stroke) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.stroke();
  }
}

function buildScenery() {
  const c = background;
  c.fillStyle = "#f6f8fa";
  c.fillRect(0, 0, WORLD_WIDTH, 720);
  c.strokeStyle = "#e8edf2";
  c.lineWidth = 1;
  for (let x = 40; x < WORLD_WIDTH; x += 40) {
    for (let y = 40; y < FLOOR - 60; y += 40) {
      c.beginPath();
      c.arc(x, y, 0.65, 0, Math.PI * 2);
      c.stroke();
    }
  }
  c.fillStyle = "#e8edf2";
  c.fillRect(0, FLOOR, WORLD_WIDTH, 100);
  c.strokeStyle = "#c8d3df";
  c.beginPath();
  c.moveTo(0, FLOOR + 0.5);
  c.lineTo(WORLD_WIDTH, FLOOR + 0.5);
  c.stroke();
  for (let x = 0; x < WORLD_WIDTH; x += 14) {
    c.beginPath();
    c.moveTo(x, FLOOR + 12);
    c.lineTo(x + 6, FLOOR + 6);
    c.stroke();
  }
  for (const platform of world.platforms) {
    const { x, width, top, color, letter } = platform;
    c.fillStyle = "#23313b0c";
    c.beginPath();
    c.ellipse(x + width / 2 + 12, FLOOR + 5, width * 0.6, 10, 0, 0, Math.PI * 2);
    c.fill();
    if (letter) {
      c.font = '900 300px "Arial Black", "Helvetica Neue", sans-serif';
      const metrics = c.measureText(letter);
      const ascent = metrics.actualBoundingBoxAscent || 220;
      c.save();
      c.translate(x, top + 6);
      c.scale(width / metrics.width, (FLOOR - top - 6) / ascent);
      c.fillStyle = color;
      c.fillText(letter, 0, ascent);
      c.restore();
      // A narrow, visible top surface makes the walkable span unambiguous,
      // including the open upper part of an L or the curve of an O.
      roundRect(c, x, top, width, 7, 3, color);
      c.fillStyle = "#ffffff50";
      c.fillRect(x + 3, top + 1, width - 6, 2);
    } else {
      roundRect(c, x, top, width, FLOOR - top, 5, color, "#a9b7c7");
      c.strokeStyle = "#b1bdcd";
      c.beginPath();
      c.moveTo(x + 8, top + 12);
      c.lineTo(x + width - 8, FLOOR - 10);
      c.moveTo(x + width - 8, top + 12);
      c.lineTo(x + 8, FLOOR - 10);
      c.stroke();
    }
  }
  // The terminal is part of the static world artwork. Only the cable moves.
  c.fillStyle = "#24313c12";
  c.beginPath();
  c.ellipse(155, FLOOR + 3, 64, 9, 0, 0, Math.PI * 2);
  c.fill();
  roundRect(c, 116, FLOOR - 47, 75, 47, 4, "#c0cbd4", "#6e7c87");
  roundRect(c, 107, FLOOR - 66, 94, 21, 5, "#d9e0e5", "#6e7c87");
  roundRect(c, 105, FLOOR - 151, 94, 83, 9, "#dce1e2", "#56636c");
  roundRect(c, 115, FLOOR - 140, 73, 53, 5, "#2c3c48");
  c.fillStyle = "#c4e2d5";
  c.font = "10px monospace";
  c.fillText("elwood_", 123, FLOOR - 120);
  c.fillStyle = "#8fa8ae";
  c.font = "7px monospace";
  c.fillText("LINK CONNECTED", 121, FLOOR - 102);
  c.fillStyle = "#365cf0";
  c.beginPath();
  c.arc(183, FLOOR - 77, 2, 0, Math.PI * 2);
  c.fill();
  c.strokeStyle = "#788b98";
  c.lineWidth = 2;
  for (let x = 120; x < 180; x += 9) {
    c.beginPath();
    c.moveTo(x, FLOOR - 59);
    c.lineTo(x + 5, FLOOR - 59);
    c.stroke();
  }
  c.fillStyle = "#536774";
  c.fillRect(195, FLOOR - 96, 10, 8);
  c.fillStyle = "#7d8f9c";
  c.font = '12px "Avenir Next", sans-serif';
  c.fillText("Home", 134, FLOOR + 43);
  c.fillText("A little higher…", 958, FLOOR + 44);
  c.fillText("You made it. Take a bow.", 1948, FLOOR + 44);
}

const rope = Array.from({ length: 42 }, (_, index) => ({
  x: 203 + index * 2,
  y: FLOOR - 92,
  px: 203 + index * 2,
  py: FLOOR - 92,
}));
const ropeStart = { x: 203, y: FLOOR - 92 };
function settleRope(end, dt) {
  const length =
    (Math.hypot(end.x - ropeStart.x, end.y - ropeStart.y) * 1.12 + 135) / (rope.length - 1);
  for (let i = 1; i < rope.length - 1; i++) {
    const p = rope[i];
    const vx = (p.x - p.px) * 0.96;
    const vy = (p.y - p.py) * 0.96;
    p.px = p.x;
    p.py = p.y;
    p.x += vx;
    p.y += vy + 850 * dt * dt;
  }
  for (let pass = 0; pass < 8; pass++) {
    Object.assign(rope[0], ropeStart);
    Object.assign(rope.at(-1), end);
    for (let i = 0; i < rope.length - 1; i++) {
      const a = rope[i];
      const b = rope[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.hypot(dx, dy) || 1;
      const correction = ((distance - length) / distance) * 0.5;
      if (i) {
        a.x += dx * correction;
        a.y += dy * correction;
      }
      if (i + 1 < rope.length - 1) {
        b.x -= dx * correction;
        b.y -= dy * correction;
      }
    }
    for (let i = 1; i < rope.length - 1; i++) {
      const p = rope[i];
      p.y = Math.min(FLOOR - 2, p.y);
      for (const block of world.platforms) {
        if (p.x > block.x - 2 && p.x < block.x + block.width + 2 && p.y > block.top - 3) {
          const leftDistance = p.x - block.x;
          const rightDistance = block.x + block.width - p.x;
          const topDistance = p.y - block.top;
          const closest = Math.min(leftDistance, rightDistance, topDistance);
          if (closest === topDistance) p.y = block.top - 3;
          else if (closest === leftDistance) p.x = block.x - 3;
          else p.x = block.x + block.width + 3;
        }
      }
    }
  }
  Object.assign(rope.at(-1), end);
}

function poseForPlayer() {
  const p = world.player;
  const clip = bank.clips.get(p.animation);
  const pose = bank.frame(p.animation, clip && world.frameIndex(clip.frames.length, accumulator));
  if (!pose) {
    if (!lastPose) return null;
    // Until a new page arrives, retain a ledge-registered image at its ledge.
    if (lastPose.clip.registration === "ledge" && !p.ledge) return lastPose;
    return positionPose(lastPose, p);
  }
  const onLedge = p.mode === "hang" || p.mode === "climb";
  const positioned = positionPose(pose, p);
  const rotationSeam =
    p.animation === "rotation" &&
    lastPose?.clip.name === "rotation" &&
    (lastPose.frame.source_clip !== pose.frame.source_clip ||
      lastPose.mirrored !== positioned.mirrored);
  if (animationName !== p.animation || rotationSeam) {
    // Decode the small planting clip during flight, before it is needed at
    // touchdown. The standing end of a climb is likewise just one tiny image.
    if (p.animation === "jump") bank.prepare("land").catch(handleSpriteError);
    if (p.animation === "land") bank.prepare("land-rest").catch(handleSpriteError);
    // Matching source frames need no blend (e.g. the turn's front endpoint).
    transition =
      lastPose && !reducedMotion && !onLedge && !samePoseImage(lastPose, positioned)
        ? { pose: lastPose, started: world.time, playerX: p.x, playerY: p.y, duration: 0.075 }
        : null;
    animationName = p.animation;
  }
  lastPose = positioned;
  bank.retainPoses(lastPose, transition?.pose);
  return positioned;
}

function paint(dt) {
  const p = world.player;
  const desired = Math.max(0, Math.min(WORLD_WIDTH - viewportWidth, p.x - viewportWidth * 0.42));
  camera = reducedMotion ? desired : camera + (desired - camera) * Math.min(1, dt * 7);
  if (Math.abs(camera - desired) < 0.05) camera = desired;
  const ratio = Math.min(devicePixelRatio || 1, 2);
  context.setTransform(ratio * zoom, 0, 0, ratio * zoom, -camera * ratio * zoom, 0);
  context.fillStyle = "#f6f8fa";
  context.fillRect(camera, 0, viewportWidth, 720);
  context.drawImage(staticScene, 0, 0);
  const pose = poseForPlayer();
  const scale = HEIGHT / 384;
  const blend = transition
    ? Math.min(1, (world.time - transition.started) / transition.duration)
    : 1;
  const outgoing = blend < 1 ? transitionPose(transition, p) : null;
  const display = pose ? blendAtSocket(pose, outgoing, blend, scale) : null;
  const endpoint = display?.endpoint ?? { x: p.x, y: p.y - HEIGHT };
  settleRope(endpoint, Math.min(dt, 1 / 30));
  context.strokeStyle = "#2e3b46";
  context.lineWidth = 2.2;
  context.lineJoin = "round";
  context.lineCap = "round";
  context.beginPath();
  context.moveTo(rope[0].x, rope[0].y);
  for (let index = 1; index < rope.length - 1; index++) {
    const a = rope[index];
    const b = rope[index + 1];
    context.quadraticCurveTo(a.x, a.y, (a.x + b.x) / 2, (a.y + b.y) / 2);
  }
  context.lineTo(endpoint.x, endpoint.y);
  context.stroke();
  const ground = p.support?.top ?? FLOOR;
  if (!["climb", "hang"].includes(p.mode)) {
    const distance = Math.max(0, ground - p.y);
    context.fillStyle = `rgba(36,49,59,${Math.max(0.025, 0.12 - distance / 1800)})`;
    context.beginPath();
    context.ellipse(p.x + 2, ground + 1, 28 - Math.min(15, distance / 15), 4, 0, 0, Math.PI * 2);
    context.fill();
  }
  if (!display?.outgoing) {
    transition = null;
    bank.retainPoses(lastPose);
  }
  spriteRenderer.draw(display?.incoming, display?.outgoing, blend, scale, ratio * zoom);
  const opacity = String(Math.max(0, 1 - camera / 180));
  if (sceneTitle.style.opacity !== opacity) sceneTitle.style.opacity = opacity;
  const label = statusForPlayer(p);
  if (label !== lastStatus) {
    stateLabel.textContent = label;
    lastStatus = label;
  }
  const message =
    p.mode === "hang"
      ? "↑ to pull up · ↓ to let go"
      : p.gestureStage === "hold"
        ? "Stay a while. Choose another action whenever you’re ready."
        : p.gestureStage === "exit"
          ? "One moment… getting ready."
          : p.x > 1900
            ? "Home is always at the other end of the cable."
            : "Walk over to the letters. See how high you can get.";
  if (hint.textContent !== message) hint.textContent = message;
}

const gestureLabels = {
  thinking: "Thinking it over",
  shrug: "Who knows?",
  wave: "Hello there",
  bow: "Thank you, thank you",
  tiptoe: "Shh… very quietly",
  "pond-hops": "One stone at a time",
  balance: "Steady… steady…",
  "crossed-arms": "I’m listening",
  "toe-touch": "Just a little further",
  "quad-stretch": "Limbering up",
  "side-stretch": "That’s the spot",
  "sleepy-yawn": "Five more minutes",
  "criss-cross": "Happy to sit a while",
  "dust-off": "Good as new",
  "bashful-toe": "Oh, hello",
  "imaginary-watch": "Any minute now",
  "air-guitar": "A private little solo",
  "little-victory": "I did a thing!",
  cartwheel: "The world looks different upside down",
  "arm-inspection": "Could use a hand",
  "punch-jump": "Here we go!",
  "disco-dance": "A tiny disco break",
  "peace-sign": "Peace, little human",
  "juggling-mime": "Keeping it all in the air",
  sneeze: "Ah… ah… achoo!",
  "dramatic-faint": "I simply cannot",
  "zero-gravity": "Forgot to turn gravity on",
  "blow-kiss": "This one is for you",
};
function statusForPlayer(player) {
  if (player.mode === "hang") return "Holding on";
  if (player.mode === "climb") return "Up we go";
  if (player.turn) return "Turning around";
  if (player.gesture) return gestureLabels[player.gesture];
  if (player.mode === "air") return "A little leap";
  if (player.animation === "idle-front") return "Hello, you";
  if (player.animation === "idle-back") return "Looking out into the world";
  if (Math.abs(player.vx) > 10) return "Out for a wander";
  return "Ready when you are";
}

function currentInput() {
  return {
    axis: Number(keys.has("right")) - Number(keys.has("left")),
    climbHeld: keys.has("climb"),
    sprint: keys.has("sprint") || keyCodes.has("ShiftLeft") || keyCodes.has("ShiftRight"),
    ...pressed,
  };
}
function frame(now) {
  if (!ready || paused || document.hidden) {
    raf = 0;
    return;
  }
  const elapsed = lastTime ? Math.min(0.05, (now - lastTime) / 1000) : 1 / 60;
  lastTime = now;
  accumulator += elapsed;
  while (accumulator >= 1 / 120) {
    world.update(1 / 120, currentInput());
    for (const key of Object.keys(pressed)) delete pressed[key];
    accumulator -= 1 / 120;
  }
  paintElapsed += elapsed;
  const resting =
    !transition &&
    world.player.mode === "ground" &&
    Math.abs(world.player.vx) < 1 &&
    (!world.player.gesture || world.player.gestureStage === "hold") &&
    !world.player.turn &&
    world.player.prepare === 0 &&
    world.player.landing === 0;
  if (!resting || paintElapsed >= 1 / 24) {
    paint(paintElapsed);
    paintElapsed = resting ? paintElapsed % (1 / 24) : 0;
  }
  raf = requestAnimationFrame(frame);
}
function startLoop() {
  if (!raf && ready && !paused && !document.hidden) {
    lastTime = 0;
    raf = requestAnimationFrame(frame);
  }
}
function resize() {
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.round(rect.width * ratio);
  canvas.height = Math.round(rect.height * ratio);
  zoom = rect.height / 720;
  viewportWidth = rect.width / zoom;
  if (ready) paint(1 / 60);
}
function clearInput() {
  keys.clear();
  keyCodes.clear();
  for (const key of Object.keys(pressed)) delete pressed[key];
}
function setPaused(value) {
  paused = value;
  clearInput();
  gestureRequest++;
  document.querySelector("#pause").textContent = paused ? "Resume" : "Pause";
  document.querySelector("#pause-overlay").hidden = !paused;
  if (paused) {
    cancelAnimationFrame(raf);
    raf = 0;
  } else {
    canvas.focus({ preventScroll: true });
    startLoop();
  }
}
function reset() {
  clearInput();
  gestureRequest++;
  world.reset();
  camera = 0;
  lastPose = null;
  transition = null;
  bank.retainPoses();
  animationName = "";
  rope.forEach((p, i) => {
    Object.assign(p, { x: 203 + i * 2, y: FLOOR - 92, px: 203 + i * 2, py: FLOOR - 92 });
  });
  setPaused(false);
  canvas.focus({ preventScroll: true });
}
async function gesture(name) {
  if (!ready || paused || world.player.mode !== "ground" || !world.clips[name]) return;
  const request = ++gestureRequest;
  try {
    const clip = await bank.prepare(name);
    world.gestureDurations[name] = clip.frames.length / clip.fps;
    if (request === gestureRequest && !paused && world.player.mode === "ground" && keys.size === 0)
      pressed.gesture = name;
  } catch (error) {
    handleSpriteError(error);
  }
}

async function face(direction) {
  if (!ready || paused || world.player.mode !== "ground") return;
  const request = ++gestureRequest;
  try {
    await bank.prepare(`idle-${direction}`);
    if (request === gestureRequest && !paused && world.player.mode === "ground")
      pressed.face = direction;
  } catch (error) {
    handleSpriteError(error);
  }
}

const mapped = {
  ArrowLeft: "left",
  KeyA: "left",
  ArrowRight: "right",
  KeyD: "right",
  ArrowUp: "climb",
  KeyW: "climb",
  KeyE: "climb",
};
window.addEventListener("keydown", (event) => {
  if (
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName)
  )
    return;
  if (
    ["BUTTON", "A", "SUMMARY"].includes(event.target.tagName) &&
    ["Space", "Enter"].includes(event.code)
  )
    return;
  const action = mapped[event.code];
  if (action || ["Space", "ArrowDown", "KeyS"].includes(event.code)) event.preventDefault();
  if (event.repeat) return;
  if (event.code === "KeyP" || event.code === "Escape") {
    setPaused(!paused);
    return;
  }
  if (event.code === "KeyR") {
    reset();
    return;
  }
  if (!ready || paused) return;
  if (event.code === "ShiftLeft" || event.code === "ShiftRight") {
    keyCodes.add(event.code);
    return;
  }
  if (action) {
    keyCodes.add(event.code);
    keys.add(action);
    gestureRequest++;
    if (action === "climb") pressed.climbPressed = true;
  }
  if (event.code === "Space") {
    pressed.jumpPressed = true;
    gestureRequest++;
  }
  if (event.code === "ArrowDown" || event.code === "KeyS") pressed.dropPressed = true;
  if (event.code === "KeyF") face("front");
  if (event.code === "KeyB") face("back");
  const button = gestureButtons.find((button) => button.dataset.code === event.code);
  if (button) gesture(button.dataset.gesture);
});
window.addEventListener("keyup", (event) => {
  keyCodes.delete(event.code);
  const action = mapped[event.code];
  if (action && ![...keyCodes].some((code) => mapped[code] === action)) keys.delete(action);
});
window.addEventListener("blur", () => {
  clearInput();
  gestureRequest++;
});
document.addEventListener("visibilitychange", () => {
  clearInput();
  gestureRequest++;
  if (document.hidden) {
    cancelAnimationFrame(raf);
    raf = 0;
  } else startLoop();
});
document.querySelector("#pause").onclick = () => setPaused(!paused);
document.querySelector("#resume").onclick = () => setPaused(false);
document.querySelector("#reset").onclick = reset;
for (const button of document.querySelectorAll("[data-command]")) {
  button.onclick = button.dataset.command === "reset" ? reset : () => setPaused(!paused);
}
for (const button of gestureButtons) {
  button.onclick = () => gesture(button.dataset.gesture);
}
for (const button of document.querySelectorAll("[data-face]")) {
  button.onclick = () => face(button.dataset.face);
}
for (const button of document.querySelectorAll("[data-hold],[data-press]")) {
  const press = () => {
    gestureRequest++;
    if (paused || !ready) return;
    if (button.dataset.hold) {
      keys.add(button.dataset.hold);
      if (button.dataset.hold === "climb") pressed.climbPressed = true;
    } else pressed[`${button.dataset.press}Pressed`] = true;
  };
  button.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    press();
  });
  const release = () => {
    if (button.dataset.hold) keys.delete(button.dataset.hold);
  };
  button.addEventListener("keydown", (event) => {
    if (!["Space", "Enter"].includes(event.code)) return;
    event.preventDefault();
    if (!event.repeat) press();
  });
  button.addEventListener("keyup", (event) => {
    if (["Space", "Enter"].includes(event.code)) {
      event.preventDefault();
      release();
    }
  });
  button.addEventListener("blur", release);
  button.addEventListener("pointerup", release);
  button.addEventListener("pointercancel", release);
  button.addEventListener("lostpointercapture", release);
}

async function boot() {
  if (bank.disposed) return;
  loading.hidden = false;
  document.querySelector("#retry").hidden = true;
  try {
    const response = await fetch(gameAssetUrl("manifest.json"));
    if (!response.ok)
      throw new Error("Couldn’t load the animation library. Check the local server and try again.");
    const manifest = await response.json();
    for (const button of gestureButtons) {
      button.disabled = !manifest.clips[button.dataset.gesture];
    }
    world.walkTransitions = manifest.walk_transitions ?? {};
    world.walkStarts = manifest.walk_starts ?? {};
    world.clips = manifest.clips;
    world.angles = manifest.angles;
    world.rotationAngles = manifest.rotation_angles;
    if (manifest.climb_exit)
      world.climbExit = { x: manifest.climb_exit.x * HEIGHT, y: manifest.climb_exit.y * HEIGHT };
    // Movement metadata is tiny. Decode only the first idle page initially;
    // direction changes fetch the already selected cycle, never its prelude.
    await Promise.all(
      [
        "idle",
        "idle-right",
        "idle-left",
        "idle-front",
        "idle-back",
        "walk-right",
        "walk-left",
        "jump",
        "land",
        "land-rest",
        "hang",
        "climb",
        "climb-rest",
        "rotation",
      ].map((name) => bank.load(name)),
    );
    await Promise.all(
      ["idle", "walk-right", "walk-left", "jump"].map((name) => bank.prepare(name)),
    );
    if (bank.disposed) return;
    ready = true;
    loading.hidden = true;
    resize();
    startLoop();
  } catch (error) {
    if (bank.disposed) return;
    loading.querySelector("p").textContent = error.message;
    document.querySelector("#retry").hidden = false;
  }
}
document.querySelector("#retry").onclick = boot;
window.addEventListener("pagehide", (event) => {
  if (event.persisted) return;
  ready = false;
  gestureRequest++;
  cancelAnimationFrame(raf);
  raf = 0;
  lastPose = transition = null;
  bank.dispose();
});
buildScenery();
new ResizeObserver(resize).observe(canvas);
boot();
