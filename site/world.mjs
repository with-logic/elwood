import { angleDelta, mirroredPose, nearestAngle, turnAngle } from "./rotation.mjs";

export const FLOOR = 620;
export const HEIGHT = 136;
export const WORLD_WIDTH = 2300;
export const PLATFORM_LAYOUT = [
  { id: "step", x: 480, width: 130, top: 545, letter: "", color: "#c8d2df" },
  { id: "e", x: 650, width: 164, top: 460, letter: "E", color: "#9babdc" },
  { id: "l", x: 854, width: 158, top: 370, letter: "L", color: "#b8c5d8" },
  { id: "w", x: 1052, width: 216, top: 285, letter: "W", color: "#8da6ce" },
  { id: "o1", x: 1308, width: 165, top: 375, letter: "O", color: "#a9b7d1" },
  { id: "o2", x: 1513, width: 165, top: 260, letter: "O", color: "#8a9ed2" },
  { id: "d", x: 1718, width: 170, top: 400, letter: "D", color: "#becad8" },
];
const RADIUS = 21;
// At the displayed height, a planted foot travels about 65–75 px/s in the
// footage. Jumping keeps this same horizontal speed; the letter gaps are 40 px.
const SPEED = 72;
const isGait = (name) => name === "run" || name.startsWith("walk");
// The new tiptoe take measures about 36.4 px/s at the displayed body height.
const GESTURE_SPEED = { tiptoe: 36 };
const LAND_DURATION = 6 / 24;
const DEFAULT_YAW = {
  idle: 30,
  "idle-right": 90,
  "idle-left": -90,
  "idle-front": 0,
  "idle-back": 180,
  "walk-right": 90,
  "walk-left": -90,
  jump: 60,
  land: 60,
  "land-rest": 60,
  "climb-rest": 70,
  hang: 70,
  climb: 70,
  thinking: 30,
  shrug: 30,
  wave: 20,
  bow: 30,
  tiptoe: 70,
  "pond-hops": 70,
  balance: 30,
  "crossed-arms": 30,
};
const GRAVITY = 1350;
const GESTURES = new Set([
  "hero-land",
  "thinking",
  "shrug",
  "wave",
  "bow",
  "tiptoe",
  "pond-hops",
  "balance",
  "crossed-arms",
  "toe-touch",
  "quad-stretch",
  "side-stretch",
  "sleepy-yawn",
  "criss-cross",
  "dust-off",
  "bashful-toe",
  "imaginary-watch",
  "air-guitar",
  "little-victory",
  "cartwheel",
  "arm-inspection",
  "punch-jump",
  "disco-dance",
  "peace-sign",
  "juggling-mime",
  "sneeze",
  "dramatic-faint",
  "zero-gravity",
  "blow-kiss",
]);
const playbackRate = (name) =>
  ["shrug", "peace-sign"].includes(name) ? 2 : name === "toe-touch" ? 1.5 : 1;
// Keep the selected hover poses independent of its full forward/reverse period.
const holdLoopRate = (clip) =>
  clip.hold_loop_seconds
    ? (2 * (clip.hold_loop[1] - clip.hold_loop[0])) / (24 * clip.hold_loop_seconds)
    : 1;
const approach = (value, target, amount) =>
  value < target ? Math.min(target, value + amount) : Math.max(target, value - amount);

export class World {
  constructor() {
    this.platforms = PLATFORM_LAYOUT;
    this.walkTransitions = {};
    this.walkStarts = {};
    this.gestureDurations = {};
    this.clips = {};
    this.angles = {};
    this.canRender = () => true;
    this.rotationAngles = Array.from({ length: 121 }, (_, i) => i * 3 - 180);
    this.climbExit = { x: 48, y: 0 };
    this.reset();
  }

  reset() {
    this.player = {
      x: 260,
      y: FLOOR,
      vx: 0,
      vy: 0,
      facing: 1,
      hasMoved: false,
      mode: "ground",
      animation: "idle",
      animationTime: 0,
      walkPhase: 0,
      support: null,
      ledge: null,
      gesture: null,
      coyote: 0.1,
      jumpBuffer: 0,
      grabCooldown: 0,
      landing: 0,
      prepare: 0,
      settle: 0,
      turn: null,
      restAnimation: null,
      restYaw: 0,
      restFrame: 0,
      pendingJump: false,
      desiredFacing: 1,
      gesturePhase: 0,
      gestureElapsed: 0,
      gestureDirection: 1,
      gestureStage: null,
      queuedAction: null,
      dropLanding: false,
    };
    this.time = 0;
  }

  poseYaw(name, facing, index = 0) {
    const clip = this.clips[name] ?? {
      direction:
        name === "walk-left" || name === "idle-left"
          ? -1
          : ["idle", "thinking", "shrug", "wave", "bow", "balance", "crossed-arms"].includes(name)
            ? 0
            : 1,
      mirror: !["idle-front", "idle-back"].includes(name),
    };
    const yaw = this.angles[name]?.[index] ?? DEFAULT_YAW[name] ?? 0;
    return yaw * (mirroredPose(clip, facing) ? -1 : 1);
  }

  currentYaw() {
    const p = this.player;
    if (p.turn) return turnAngle(p.turn);
    if (p.animation === "rotation") return p.restYaw;
    return this.poseYaw(
      p.animation,
      p.facing,
      this.frameIndex(this.angles[p.animation]?.length ?? 1),
    );
  }

  transitionTo(name, facing) {
    const p = this.player;
    if (p.turn?.target === name && p.turn.facing === facing) return;
    if (!p.turn && p.animation === name && p.facing === facing) return;
    // Walking and its matching idle keep the same heading. Estimated angles
    // differ between takes; turning to correct that difference causes a twitch.
    const side = facing === -1 ? "left" : "right";
    const gait = [`walk-${side}`, `idle-${side}`, "run"];
    if (p.facing === facing && gait.includes(p.animation) && gait.includes(name)) {
      this.animate(name);
      return;
    }
    const from = this.currentYaw();
    const entry = isGait(name) ? (this.walkStarts[name] ?? 0) : 0;
    const delta = angleDelta(from, this.poseYaw(name, facing, entry));
    if (Math.abs(delta) < 10) {
      p.turn = null;
      p.facing = facing;
      this.animate(name);
      return;
    }
    p.turn = {
      from,
      delta,
      elapsed: 0,
      duration: Math.max(0.12, Math.abs(delta) / 330),
      target: name,
      facing,
    };
    p.vx = 0;
    this.animate("rotation", true);
  }

  groundMotion(dt, requestedInput, requestedAxis) {
    // A gesture in progress swallows movement input until it finishes, then
    // replays whatever was queued behind it; both are local to this step.
    let input = requestedInput;
    let axis = requestedAxis;
    const p = this.player;
    if (p.turn && this.canRender("rotation", this.frameIndex(this.rotationAngles.length)))
      p.turn.elapsed += dt;
    // A folded pose, airborne trick or detached limb must recover first.
    // Queue discrete requests; held movement is read again when recovery ends.
    if (this.needsRecovery()) {
      if (
        axis ||
        input.jumpPressed ||
        input.face ||
        input.gesture ||
        input.idle ||
        input.releaseGesture ||
        input.dropPressed ||
        input.climbPressed
      ) {
        p.gestureStage = "exit";
        p.gestureDirection = 1;
        if (input.releaseGesture) p.queuedAction = null;
        if (axis) p.queuedAction = p.queuedAction?.jumpPressed ? { jumpPressed: true } : null;
        if (input.gesture)
          p.queuedAction = input.gesture === p.gesture ? null : { gesture: input.gesture };
        if (input.face) p.queuedAction = { face: input.face };
        if (input.idle) p.queuedAction = { idle: true };
        if (input.jumpPressed) p.queuedAction = { jumpPressed: true };
        if (input.dropPressed) p.queuedAction = { dropPressed: true };
        if (input.climbPressed) p.queuedAction = { climbPressed: true };
      }
      if (p.gestureElapsed < (this.gestureDurations[p.gesture] ?? 6)) {
        input = {};
        axis = 0;
        p.jumpBuffer = 0;
      } else {
        input = { ...p.queuedAction, ...input };
        p.queuedAction = null;
        if (input.jumpPressed) p.jumpBuffer = 0.13;
      }
    }
    if (p.gesture && p.gestureElapsed >= (this.gestureDurations[p.gesture] ?? 6)) {
      const count = this.clips[p.gesture]?.frames ?? this.angles[p.gesture]?.length ?? 1;
      const yaw = this.poseYaw(p.gesture, p.facing, count - 1);
      p.restFrame = nearestAngle(this.rotationAngles, yaw);
      p.restYaw = this.rotationAngles[p.restFrame];
      p.restAnimation = "rotation";
      p.gesture = null;
      p.gestureStage = null;
      this.animate("rotation");
    }
    if (input.dropPressed && p.support) {
      this.release();
      return;
    }
    if (input.climbPressed && p.grabCooldown === 0) {
      const ledge = this.nearLedge();
      if (ledge) {
        this.grab(ledge);
        return;
      }
    }
    if (input.gesture && GESTURES.has(input.gesture)) {
      p.gesture = input.gesture;
      p.gestureElapsed = 0;
      p.gesturePhase = 0;
      p.gestureDirection = 1;
      p.gestureStage = "enter";
      p.queuedAction = null;
      p.restAnimation = null;
    }
    if (["front", "back"].includes(input.face)) {
      p.restAnimation = `idle-${input.face}`;
      p.gesture = null;
      p.gestureStage = null;
      p.queuedAction = null;
    }
    if (input.idle) {
      p.restAnimation = "idle";
      p.gesture = null;
      p.gestureStage = null;
      p.queuedAction = null;
    }
    if (axis || input.jumpPressed) {
      p.gesture = null;
      p.gestureStage = null;
      p.queuedAction = null;
      p.restAnimation = null;
    }
    if (axis) {
      p.desiredFacing = axis;
      p.hasMoved = true;
    }
    if (p.jumpBuffer > 0 && p.coyote > 0) {
      p.pendingJump = true;
      p.jumpBuffer = 0;
    }

    const facing = p.desiredFacing;
    const moving = axis || (isGait(p.animation) && Math.abs(p.vx) > 10);
    const gait = input.sprint && this.clips.run ? "run" : facing === 1 ? "walk-right" : "walk-left";
    const name =
      p.pendingJump || p.prepare > 0
        ? "jump"
        : (p.gesture ??
          (moving
            ? gait
            : (p.restAnimation ??
              (p.hasMoved ? (facing === 1 ? "idle-right" : "idle-left") : "idle"))));
    this.transitionTo(name, facing);
    if (p.turn) {
      if (
        p.turn.elapsed < p.turn.duration ||
        !this.canRender(p.turn.target, this.walkStarts[p.turn.target] ?? 0)
      ) {
        p.vx = 0;
        return;
      }
      const completed = p.turn;
      p.turn = null;
      p.facing = completed.facing;
      this.animate(completed.target, true);
    }
    if (p.pendingJump && p.prepare === 0) {
      p.pendingJump = false;
      p.prepare = 0.11;
      p.restAnimation = null;
      this.animate("jump", true);
    }
    if (p.prepare > 0) {
      p.vx = 0;
      p.prepare = Math.max(0, p.prepare - dt);
      if (p.prepare === 0) {
        p.vy = -610;
        p.mode = "air";
        p.support = null;
        p.coyote = 0;
      }
      return;
    }
    if (
      isGait(p.animation) &&
      !this.canRender(p.animation, this.frameIndex(this.clips[p.animation]?.frames ?? 1))
    ) {
      p.vx = 0;
      return;
    }
    // Gesture duration is measured in source seconds, as is its frame clock.
    if (p.gesture) {
      const clip = this.clips[p.gesture];
      const hold = clip?.hold_frame;
      const loop = clip?.hold_loop;
      let direction = p.gestureDirection;
      let stage = p.gestureStage;
      const rate = loop && stage === "hold" ? holdLoopRate(clip) : playbackRate(p.gesture);
      let next = p.gestureElapsed + (p.animationTime > 0 ? dt * rate * direction : 0);
      if (loop && stage !== "exit" && (stage === "hold" || next >= loop[0] / 24)) {
        stage = "hold";
        const start = loop[0] / 24;
        const end = loop[1] / 24;
        if (next >= end) {
          next = 2 * end - next;
          direction = -1;
        } else if (next <= start) {
          next = 2 * start - next;
          direction = 1;
        }
      } else if (hold != null && stage !== "exit" && next >= hold / 24) {
        next = hold / 24;
        stage = "hold";
      }
      const count = this.clips[p.gesture]?.frames ?? Number.POSITIVE_INFINITY;
      if (!this.canRender(p.gesture, Math.min(count - 1, Math.floor(next * 24)))) {
        // Travel must pause with the source pose while a new page decodes.
        p.vx = 0;
        return;
      }
      p.gestureElapsed = next;
      p.gestureDirection = direction;
      p.gestureStage = stage;
    }
    const gestureSpeed = GESTURE_SPEED[p.gesture];
    const desired = gestureSpeed
      ? p.facing * gestureSpeed
      : p.gesture || p.restAnimation
        ? 0
        : axis * this.gaitSpeed(p.animation);
    const travel = this.clips[p.gesture]?.travel_speed;
    // Source-measured flight windows move a hop; a planted source frame stops
    // immediately, so the landing never glides through a deceleration tail.
    p.vx = travel
      ? p.facing * (travel[Math.min(travel.length - 1, Math.floor(p.gestureElapsed * 24))] ?? 0)
      : approach(p.vx, desired, 1100 * dt);
    if (gestureSpeed) p.gesturePhase += dt * 24 * Math.abs(p.vx / gestureSpeed);
  }

  gaitSpeed(name) {
    return this.clips[name]?.move_speed ?? SPEED;
  }

  animate(name, restart = false) {
    if (this.player.animation !== name || restart) {
      if (isGait(name)) {
        const mapping = this.walkTransitions[`${this.player.animation}>${name}`];
        this.player.walkPhase = mapping
          ? mapping[Math.floor(this.player.walkPhase) % mapping.length]
          : (this.walkStarts[name] ?? 0);
      }
      this.player.animation = name;
      this.player.animationTime = 0;
    }
  }

  dropFromPickup() {
    const p = this.player;
    Object.assign(p, {
      mode: "air",
      vx: 0,
      vy: 30,
      grabCooldown: 1,
      coyote: 0,
      jumpBuffer: 0,
      desiredFacing: p.facing,
      dropLanding: !!this.clips["hero-land"],
    });
    this.animate(p.dropLanding && this.clips["pickup-fall"] ? "pickup-fall" : "jump", true);
  }

  needsRecovery() {
    const p = this.player;
    const clip = this.clips[p.gesture];
    return (
      p.gesture &&
      p.animation === p.gesture &&
      (clip?.hold_frame != null || clip?.hold_loop || clip?.finish_before_next)
    );
  }

  nearLedge() {
    const p = this.player;
    for (const platform of this.platforms) {
      const edge = p.facing === 1 ? platform.x : platform.x + platform.width;
      if (
        Math.abs(p.x - edge) < 48 &&
        (p.x - edge) * p.facing < 10 &&
        p.y - platform.top > HEIGHT * 0.55 &&
        p.y - platform.top < HEIGHT * 1.2 &&
        platform.top < FLOOR - HEIGHT
      )
        return { platform, edge, direction: p.facing };
    }
  }

  grab(ledge) {
    const p = this.player;
    p.ledge = ledge;
    p.mode = "hang";
    p.vx = 0;
    p.vy = 0;
    p.support = null;
    p.dropLanding = false;
    p.x = ledge.edge - p.facing * 24;
    p.y = ledge.platform.top + HEIGHT;
    p.gesture = null;
    p.gestureStage = null;
    p.queuedAction = null;
    p.jumpBuffer = 0;
    p.restAnimation = null;
    p.turn = null;
    p.pendingJump = false;
    p.desiredFacing = p.facing;
    this.animate("hang", true);
  }

  release() {
    const p = this.player;
    if (p.ledge) p.x = p.ledge.edge - p.facing * (RADIUS + 3);
    else if (p.support)
      p.x = p.facing === 1 ? p.support.x + p.support.width + RADIUS + 3 : p.support.x - RADIUS - 3;
    p.y += 2;
    p.ledge = null;
    p.support = null;
    p.mode = "air";
    p.vy = 45;
    p.grabCooldown = 0.5;
    p.coyote = 0;
    p.jumpBuffer = 0;
    p.gesture = null;
    p.gestureStage = null;
    p.queuedAction = null;
    p.restAnimation = null;
    p.turn = null;
    p.pendingJump = false;
    this.animate("jump", true);
  }

  update(step, input = {}) {
    // A long frame is clamped so one stall cannot tunnel the player through the
    // world; every later use reads the clamped `dt`.
    const dt = Math.min(step, 1 / 30);
    const p = this.player;
    const axis = Math.sign(input.axis || 0);
    this.time += dt;
    p.animationTime += dt;
    if (isGait(p.animation))
      p.walkPhase += (dt * 24 * Math.abs(p.vx)) / this.gaitSpeed(p.animation);
    p.grabCooldown = Math.max(0, p.grabCooldown - dt);
    p.jumpBuffer = input.jumpPressed ? 0.13 : Math.max(0, p.jumpBuffer - dt);
    p.coyote = p.mode === "ground" ? 0.1 : Math.max(0, p.coyote - dt);
    p.landing = Math.max(0, p.landing - dt);
    p.settle = Math.max(0, p.settle - dt);

    if (p.mode === "hang") {
      if (input.dropPressed || input.jumpPressed) this.release();
      else if (input.climbPressed) {
        p.mode = "climb";
        this.animate("climb", true);
      }
      return;
    }
    if (p.mode === "climb") {
      if (input.dropPressed) {
        this.release();
        return;
      }
      if (p.animationTime >= (this.clips.climb?.frames ?? 199) / (this.clips.climb?.fps ?? 48)) {
        p.x = p.ledge.edge + p.facing * this.climbExit.x;
        p.y = p.ledge.platform.top + this.climbExit.y;
        p.support = p.ledge.platform;
        p.ledge = null;
        p.mode = "ground";
        p.hasMoved = true;
        p.restAnimation = "climb-rest";
        p.settle = 0.12;
        this.animate(p.restAnimation);
      }
      return;
    }

    // Input cannot move or mirror a planted landing/climb completion. Jump
    // buffering still runs above, so a fresh press near the end can take off.
    if (p.landing > 0 || p.settle > 0) {
      p.vx = 0;
      return;
    }
    const recoveringPose = this.needsRecovery();
    if (!recoveringPose && input.dropPressed && p.support) {
      this.release();
      return;
    }
    if (!recoveringPose && input.climbPressed && p.grabCooldown === 0) {
      const ledge = this.nearLedge();
      if (ledge) {
        this.grab(ledge);
        return;
      }
    }
    if (p.mode === "ground") this.groundMotion(dt, input, axis);
    else {
      if (p.jumpBuffer > 0 && p.coyote > 0) {
        p.vy = -610;
        p.coyote = 0;
        p.jumpBuffer = 0;
      }
      // Steer gently in flight without flipping the airborne sprite. Any new
      // facing request turns after the landing has planted.
      p.vx = p.dropLanding ? 0 : approach(p.vx, axis * SPEED, 450 * dt);
      if (axis && !p.dropLanding) {
        p.desiredFacing = axis;
        p.hasMoved = true;
      }
    }

    const previousX = p.x;
    const previousY = p.y;
    p.x = Math.max(
      this.bounds?.left ?? 58,
      Math.min(this.bounds?.right ?? WORLD_WIDTH - 60, p.x + p.vx * dt),
    );
    for (const platform of this.platforms) {
      if (platform.solid === false) continue;
      if (p.y <= platform.top + 2 || p.y - HEIGHT >= FLOOR) continue;
      if (previousX + RADIUS <= platform.x + 0.1 && p.x + RADIUS > platform.x) {
        p.x = platform.x - RADIUS;
        p.vx = 0;
      }
      if (
        previousX - RADIUS >= platform.x + platform.width - 0.1 &&
        p.x - RADIUS < platform.x + platform.width
      ) {
        p.x = platform.x + platform.width + RADIUS;
        p.vx = 0;
      }
    }
    // Nothing walks inside a solid block. A drop from a pickup or a travelling
    // gesture that ends within its footprint is pushed out to the nearer side,
    // where the ledge grab can actually reach the top.
    for (const platform of this.platforms) {
      if (platform.solid !== true || p.y <= platform.top + 2 || p.support === platform) continue;
      if (p.x <= platform.x - RADIUS || p.x >= platform.x + platform.width + RADIUS) continue;
      const toLeft = p.x - platform.x;
      const toRight = platform.x + platform.width - p.x;
      p.x = toLeft <= toRight ? platform.x - RADIUS : platform.x + platform.width + RADIUS;
      p.vx = 0;
    }
    if (
      p.mode === "ground" &&
      p.support &&
      (p.x < p.support.x - 5 || p.x > p.support.x + p.support.width + 5)
    ) {
      p.support = null;
      p.mode = "air";
      this.animate("jump", true);
    }
    if (p.mode === "air") {
      p.vy += GRAVITY * dt;
      p.y += p.vy * dt;
      if (p.vy >= 0) {
        const landing = this.platforms.find(
          (platform) =>
            previousY <= platform.top + 2 &&
            p.y >= platform.top &&
            p.x > platform.x - 5 &&
            p.x < platform.x + platform.width + 5,
        );
        if (landing || p.y >= FLOOR) {
          p.y = landing?.top ?? FLOOR;
          p.vx = 0;
          p.vy = 0;
          p.mode = "ground";
          p.support = landing ?? null;
          p.gesture = null;
          p.gestureStage = null;
          p.queuedAction = null;
          p.turn = null;
          if (p.dropLanding) {
            p.dropLanding = false;
            p.landing = 0;
            p.restAnimation = null;
            p.gesture = "hero-land";
            p.gestureElapsed = 0;
            p.gestureDirection = 1;
            p.gestureStage = "enter";
            this.animate("hero-land", true);
          } else {
            p.landing = LAND_DURATION;
            p.restAnimation = "land-rest";
            this.animate("land", true);
          }
        }
      }
      if (
        p.mode === "air" &&
        p.grabCooldown === 0 &&
        (input.climbHeld || (axis && p.vx === 0 && p.vy > -80))
      ) {
        const ledge = this.nearLedge();
        if (ledge) {
          this.grab(ledge);
          return;
        }
      }
    }
    if (p.landing > 0) this.animate("land");
    else if (p.mode === "air")
      this.animate(p.dropLanding && this.clips["pickup-fall"] ? "pickup-fall" : "jump");
  }

  frameIndex(count, interpolation = 0) {
    const p = this.player;
    if (count <= 1) return 0;
    if (p.animation === "jump") {
      if (p.prepare > 0) return Math.min(count - 1, Math.floor((1 - p.prepare / 0.11) * 14));
      if (p.vy < 0)
        return Math.min(count - 1, 19 + Math.floor((1 - Math.min(1, -p.vy / 610)) * 12));
      return Math.min(count - 1, 33 + Math.floor(Math.min(1, p.vy / 610) * 11));
    }
    if (p.turn)
      return Math.min(
        count - 1,
        nearestAngle(this.rotationAngles, turnAngle(p.turn, interpolation)),
      );
    if (p.animation === "rotation") return Math.min(count - 1, p.restFrame);
    if (p.animation === "land")
      return Math.min(count - 1, Math.floor((p.animationTime + interpolation) * 24 + 1e-7));
    if (GESTURE_SPEED[p.animation]) {
      const frame = Math.floor(
        p.gesturePhase + interpolation * 24 * Math.abs(p.vx / GESTURE_SPEED[p.animation]) + 1e-7,
      );
      return Math.min(count - 1, frame);
    }
    if (p.animation === "climb")
      return Math.min(
        count - 1,
        Math.floor((p.animationTime + interpolation) * (this.clips.climb?.fps ?? 48) + 1e-7),
      );
    if (isGait(p.animation))
      return (
        Math.floor(
          p.walkPhase + (interpolation * 24 * Math.abs(p.vx)) / this.gaitSpeed(p.animation) + 1e-7,
        ) % count
      );
    const clock =
      p.gesture === p.animation ? p.gestureElapsed : p.animationTime * playbackRate(p.animation);
    const loop = this.clips[p.animation]?.hold_loop;
    if (loop && p.gesture === p.animation && p.gestureStage === "hold") {
      const span = loop[1] - loop[0];
      const source =
        (clock + interpolation * p.gestureDirection * holdLoopRate(this.clips[p.animation])) * 24;
      const phase = (((source - loop[0]) % (2 * span)) + 2 * span) % (2 * span);
      return Math.floor(loop[0] + (phase <= span ? phase : 2 * span - phase) + 1e-7);
    }
    const extra =
      p.gestureStage === "hold" && p.gesture === p.animation
        ? 0
        : interpolation * playbackRate(p.animation);
    const frame = Math.floor((clock + extra) * 24 + 1e-7);
    if (p.animation === "idle" || p.animation.startsWith("idle-")) {
      const period = 2 * (count - 1);
      const phase = frame % period;
      return phase < count ? phase : period - phase;
    }
    // Interpolated rendering can reach the end before the next physics tick
    // changes the action. Hold the final pose instead of flashing frame zero.
    if (p.animation === "pickup-fall" || GESTURES.has(p.animation))
      return Math.min(count - 1, frame);
    return frame % count;
  }
}
