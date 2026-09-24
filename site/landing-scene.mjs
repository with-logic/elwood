/** Renders the interactive robot and tether (PRD §13; docs/design/landing.md). */
import { AutomaticPreparation } from "./autonomy/preparation.mjs";
import { Autonomy, NO_INPUT } from "./autonomy.mjs";
import { gameAssetUrl } from "./game-assets.mjs";
import { mirroredPose } from "./rotation.mjs";
import { SpriteBank } from "./sprite-bank.mjs";
import { withSpriteAssetErrorContext } from "./sprite-asset-error.mjs";
import {
  blendAtSocket,
  positionPose,
  samePoseImage,
  socketPosition,
  transitionPose,
} from "./sprite-pose.mjs";
import { SpriteRenderer } from "./sprite-renderer.mjs";
import { Tether } from "./tether.mjs";
import { FLOOR, HEIGHT, World } from "./world.mjs";

export class LandingScene {
  constructor(canvas, { onReady, onPaint, onError, onMode, onBounds } = {}) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d");
    this.renderer = new SpriteRenderer(this.context, document.createElement("canvas"));
    this.world = new World();
    this.bank = new SpriteBank((error) => onError?.(error));
    this.world.canRender = (name, index) => !!this.bank.frame(name, index);
    this.automaticPreparation = new AutomaticPreparation(this);
    this.director = new Autonomy({
      ready: (name, task) => this.automaticPreparation.ready(name, task),
      fits: (name, _world, task) => this.performanceFits(name, task),
      onTaskEnd: (task) => this.automaticPreparation.cancel(task),
    });
    this.onReady = onReady;
    this.onPaint = onPaint;
    this.onError = onError;
    this.onMode = onMode;
    this.onBounds = onBounds;
    this.drag = null;
    this.pending = new Set();
    this.pressed = NO_INPUT;
    this.axis = 0;
    this.climbHeld = false;
    this.sprint = false;
    this.pauses = new Set(["boot"]);
    this.raf = 0;
    this.accumulator = 0;
    this.paintElapsed = 0;
    this.lastTime = 0;
    this.lastPose = null;
    this.transition = null;
    this.animationName = "";
    this.requestVersion = 0;
    this.preparingRequestVersion = null;
    this.camera = 0;
    this.tether = new Tether();
    this.ready = false;
    this.config = {
      width: 1000,
      height: 800,
      scale: 1.5,
      floorY: 620,
      robotX: 500,
      terminal: { x: 500, y: 170 },
      platforms: [],
    };
    this.dirt = this.makeDirt();
    this.groundMarks = [];
    this.reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (this.reduced) this.pauses.add("reduced");
    this.frame = this.frame.bind(this);
  }
  makeDirt() {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 40;
    const c = canvas.getContext("2d");
    let seed = 71027;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < 410; i++) {
      const x = random() * 640;
      const strength = (1 - Math.abs(x - 320) / 320) ** 1.8;
      const y = 17 + (random() - 0.5) * 17 * strength;
      c.strokeStyle = `rgba(0,0,0,${strength * random() * 0.42})`;
      c.lineWidth = random() < 0.9 ? 0.65 : 1.1;
      c.beginPath();
      c.moveTo(x, y);
      c.lineTo(x + 1 + random() * 30, y + (random() - 0.5) * 1.8);
      c.stroke();
    }
    return canvas;
  }
  async boot() {
    if (this.bank.disposed) return;
    try {
      const manifest = await withSpriteAssetErrorContext("manifest.json", async () => {
        const response = await fetch(gameAssetUrl("manifest.json"));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      });
      const w = this.world;
      Object.assign(w, {
        clips: manifest.clips,
        angles: manifest.angles,
        rotationAngles: manifest.rotation_angles,
        walkTransitions: manifest.walk_transitions,
        walkStarts: manifest.walk_starts,
      });
      for (const [name, clip] of Object.entries(manifest.clips))
        w.gestureDurations[name] = clip.frames / clip.fps;
      if (manifest.climb_exit)
        w.climbExit = { x: manifest.climb_exit.x * HEIGHT, y: manifest.climb_exit.y * HEIGHT };
      const idle = await this.bank.prepareAnimation("idle");
      if (!idle || this.bank.disposed) return;
      this.bank.publishAnimation("idle");
      this.bank.activateAnimation("idle");
      this.ready = true;
      this.configure(this.config, true);
      this.onReady?.();
      this.pause("boot", false);
      this.paint(0);
    } catch (error) {
      this.onError?.(error);
    }
  }
  dispose() {
    this.ready = false;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.cancelRequest();
    this.lastPose = null;
    this.transition = null;
    this.bank.dispose();
    this.onReady = this.onPaint = this.onError = this.onMode = this.onBounds = undefined;
  }
  prepare(name) {
    const clip = this.bank.clips.get(name);
    if (clip && this.bank.pages.has(`${name}/${clip.frames[0].page}`)) return true;
    if (!this.pending.has(name)) {
      this.pending.add(name);
      this.bank
        .prepare(name)
        .catch((error) => this.onError?.(error))
        .finally(() => this.pending.delete(name));
    }
    return false;
  }
  performanceFits(name, task) {
    const clip = this.bank.clips.get(name);
    const p = this.world.player;
    const cfg = this.config;
    if (!clip) {
      if (task) this.automaticPreparation.metadata(name, task);
      else this.bank.ensureMetadata(name);
      return null;
    }
    const unit = HEIGHT / 384;
    const top = FLOOR + (8 - cfg.floorY) / cfg.scale;
    const right = (cfg.width - 8) / cfg.scale;
    const bottom = FLOOR + (cfg.height - 8 - cfg.floorY) / cfg.scale;
    let travel = 0;
    // Check the recorded silhouette and travel once before an automatic trick.
    // A large airborne pose needs more room than the standing character.
    return clip.frames.every((frame, index) => {
      travel += (this.world.clips[name].travel_speed?.[index] ?? (name === "tiptoe" ? 36 : 0)) / 24;
      const x = p.x + travel * p.facing;
      const mirrored = mirroredPose(clip, p.facing, frame);
      const left = x + (mirrored ? frame.anchor.x - frame.w : -frame.anchor.x) * unit;
      return (
        left >= 8 / cfg.scale &&
        left + frame.w * unit <= right &&
        p.y - frame.anchor.y * unit >= top &&
        p.y + (frame.h - frame.anchor.y) * unit <= bottom
      );
    });
  }
  configure(config, reset = false) {
    const old = this.config;
    const widthRatio = config.width / old.width;
    this.config = config;
    const w = this.world;
    const ratio = Math.min(devicePixelRatio || 1, 2);
    const width = Math.round(config.width * ratio);
    const height = Math.round(config.height * ratio);
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    const margin = Math.min(config.scale * 58, config.width * 0.28) / config.scale;
    this.visibleBounds = {
      left: Math.max(20, margin),
      right: config.width / config.scale - margin,
      top: FLOOR + (24 - config.floorY) / config.scale + HEIGHT,
    };
    w.bounds = { ...this.visibleBounds };
    w.platforms = config.platforms;
    const homeX = config.robotX / config.scale;
    this.homeSpot = { x: homeX, y: this.standingTop(homeX) };
    if (reset) {
      this.cancelRequest();
      this.drag = null;
      w.reset();
      w.player.x = homeX;
      this.settle();
      this.director.resume(5);
      this.groundMarks = [];
      this.markGround();
      this.lastPose = null;
      this.transition = null;
      this.bank.retainPoses();
      this.animationName = "";
      this.tether.points = null;
    } else if (
      Math.abs(old.width - config.width) > 1 ||
      Math.abs(old.height - config.height) > 1 ||
      Math.abs(old.scale - config.scale) > 0.01
    ) {
      // A responsive reflow starts from a valid floor, never from a vanished ledge.
      this.cancelRequest();
      const x = (w.player.x * widthRatio * old.scale) / config.scale;
      this.drag = null;
      w.reset();
      w.player.x = Math.max(w.bounds.left, Math.min(w.bounds.right, x));
      this.settle();
      this.groundMarks = [];
      this.markGround();
      this.lastPose = null;
      this.transition = null;
      this.bank.retainPoses();
      this.tether.points = null;
    }
    if (this.ready) this.paint(0);
  }
  interact() {
    this.director.interact();
    this.invalidateRequest();
    this.pauses.delete("reduced");
    this.start();
  }
  async request(input) {
    if (!this.ready) return;
    this.interact();
    const version = this.requestVersion;
    const name = input.gesture ?? (input.face ? `idle-${input.face}` : null);
    if (name && !this.acceptsAnimationInput()) return;
    this.preparingRequestVersion = version;
    try {
      if (name && !await this.bank.prepareAnimation(name)) return;
      if (version !== this.requestVersion) return;
      if (name && !this.acceptsAnimationInput()) { this.bank.cancelPreparation(); return; }
      if (name) this.bank.publishAnimation(name);
      this.pressed = { ...this.pressed, ...input };
    } catch (error) {
      if (version === this.requestVersion) this.onError?.(error);
    } finally {
      if (this.preparingRequestVersion === version) this.preparingRequestVersion = null;
    }
  }
  acceptsAnimationInput() {
    const p = this.world.player;
    return !this.drag && !this.axis && p.mode === "ground" && !p.landing && !p.settle && !p.pendingJump && !p.prepare;
  }
  invalidateRequest() {
    this.requestVersion++;
    if (this.pressed.gesture || this.pressed.face) {
      this.pressed = { ...this.pressed };
      delete this.pressed.gesture;
      delete this.pressed.face;
      if (!Object.keys(this.pressed).length) this.pressed = NO_INPUT;
    }
    const queued = this.world.player.queuedAction;
    if (queued?.gesture || queued?.face) this.world.player.queuedAction = null;
    // Before readiness, boot owns preparation; teardown cancels it through bank.dispose().
    if (this.ready) this.bank.cancelPreparation();
  }
  cancelRequest() {
    this.director.task = null;
    this.pressed = NO_INPUT;
    this.invalidateRequest();
  }
  clearInput() {
    this.axis = 0;
    this.climbHeld = false;
    this.sprint = false;
    this.cancelRequest();
  }
  get dragging() {
    return this.drag !== null;
  }
  worldPoint(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const cfg = this.config;
    return {
      x: (clientX - rect.left) / cfg.scale + this.camera,
      y: FLOOR + (clientY - rect.top - cfg.floorY) / cfg.scale,
    };
  }
  beginDrag(point) {
    if (!this.ready || this.manuallyPaused || this.drag) return false;
    this.clearInput();
    this.interact();
    this.onMode?.("manual");
    const p = this.world.player;
    const socket = this.lastPose
      ? socketPosition(this.lastPose, HEIGHT / 384)
      : { x: p.x, y: p.y - HEIGHT };
    const name = this.world.clips["pickup-wriggle"] ? "pickup-wriggle" : "zero-gravity";
    this.drag = { point, offset: { x: socket.x - point.x, y: socket.y - point.y }, socket, name };
    Object.assign(p, {
      mode: "drag",
      vx: 0,
      vy: 0,
      support: null,
      ledge: null,
      gesture: null,
      gestureStage: null,
      queuedAction: null,
      turn: null,
      landing: 0,
      prepare: 0,
      settle: 0,
      pendingJump: false,
      restAnimation: null,
    });
    this.prepare(name);
    for (const clip of this.world.clips["hero-land"] ? ["hero-land", "pickup-fall"] : ["land"])
      this.prepare(clip);
    this.world.animate(name, true);
    this.moveDrag(point);
    return true;
  }
  moveDrag(point, userInput = true) {
    if (!this.drag) return;
    const cfg = this.config;
    const p = this.world.player;
    const clip = this.bank.clips.get(this.drag.name);
    const unit = HEIGHT / 384;
    if (clip && this.drag.boundsClip !== clip) {
      this.drag.boundsClip = clip;
      this.drag.bounds = clip.frames.reduce(
        (bounds, f) => ({
          radius: Math.max(
            bounds.radius,
            (f.anchor.x + f.socket.x) * unit,
            (f.w - f.anchor.x - f.socket.x) * unit,
          ),
          below: Math.max(bounds.below, (f.h - f.anchor.y - f.socket.y) * unit),
          above: Math.max(bounds.above, (f.anchor.y + f.socket.y) * unit),
        }),
        { radius: 0, below: 0, above: 0 },
      );
    }
    const bounds = this.drag.bounds ?? {
      radius: HEIGHT * 0.65,
      below: HEIGHT * 1.1,
      above: HEIGHT * 0.15,
    };
    const margin = bounds.radius + 6 / cfg.scale;
    const x = Math.max(
      this.camera + margin,
      Math.min(this.camera + cfg.width / cfg.scale - margin, point.x + this.drag.offset.x),
    );
    const y = Math.max(
      FLOOR + (6 - cfg.floorY) / cfg.scale + bounds.above,
      Math.min(FLOOR - bounds.below - 2, point.y + this.drag.offset.y),
    );
    p.x += x - this.drag.socket.x;
    p.y += y - this.drag.socket.y;
    this.drag.point = point;
    this.drag.socket = { x, y };
    if (userInput) this.interact();
  }
  nudgeDrag(dx, dy) {
    if (this.drag) this.moveDrag({ x: this.drag.point.x + dx, y: this.drag.point.y + dy });
  }
  endDrag() {
    if (!this.drag) return;
    const p = this.world.player;
    const fall = this.bank.clips.get("pickup-fall");
    const unit = HEIGHT / 384;
    if (fall) {
      const f = fall.frames[0];
      const mirror = mirroredPose(fall, p.facing, f);
      p.x = this.drag.socket.x - f.socket.x * unit * (mirror ? -1 : 1);
      p.y = Math.min(FLOOR - 2, this.drag.socket.y - f.socket.y * unit);
    } else if (this.lastPose?.clip.name === this.drag.name) {
      p.y = Math.min(
        FLOOR - 2,
        this.lastPose.y + ((this.lastPose.frame.h - this.lastPose.frame.anchor.y) * HEIGHT) / 384,
      );
    }
    this.drag = null;
    this.clearInput();
    this.interact();
    this.world.dropFromPickup();
  }
  get userPaused() {
    return this.pauses.has("user") || this.pauses.has("reduced");
  }
  get manuallyPaused() {
    return this.pauses.has("user");
  }
  resumePlayback() {
    this.pauses.delete("reduced");
    this.pause("user", false);
  }
  toggleUserPause() {
    if (this.userPaused) this.resumePlayback();
    else this.pause("user", true);
  }
  pause(reason, value) {
    if (value) {
      this.endDrag();
      this.pauses.add(reason);
      this.clearInput();
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    } else {
      this.pauses.delete(reason);
      this.start();
    }
  }
  start() {
    if (!this.raf && this.ready && !this.pauses.size) {
      this.lastTime = 0;
      this.raf = requestAnimationFrame(this.frame);
    }
  }
  home() {
    this.clearInput();
    this.configure(this.config, true);
    this.interact();
  }
  standingTop(x) {
    const under = this.world.platforms.find(
      (platform) => platform.solid === true && x >= platform.x && x <= platform.x + platform.width,
    );
    return under?.top ?? FLOOR;
  }
  // A solid block under him (the wide poster's headline) is where he stands,
  // so a reset or reflow never drops him through it from the floor line.
  settle() {
    const p = this.world.player;
    if (p.y !== FLOOR) return;
    const under = this.world.platforms.find(
      (platform) =>
        platform.solid === true && p.x >= platform.x && p.x <= platform.x + platform.width,
    );
    if (under) {
      p.y = under.top;
      p.support = under;
    }
  }
  markGround() {
    // The one patch of pen-like ground stays under the terminal, centre
    // screen, wherever he wanders.
    this.groundMarks = [{ ...this.homeSpot }];
  }
  step(dt) {
    if (this.drag) {
      this.world.time += dt;
      this.world.player.animationTime += dt;
      return;
    }
    const active = this.axis !== 0 || this.climbHeld || this.pressed !== NO_INPUT
      || this.preparingRequestVersion === this.requestVersion;
    const automatic = this.director.update(dt, this.world, this.visibleBounds, active);
    const wasAirborne = this.world.player.mode !== "ground";
    this.world.update(
      dt,
      active
        ? { axis: this.axis, climbHeld: this.climbHeld, sprint: this.sprint, ...this.pressed }
        : automatic,
    );
    this.pressed = NO_INPUT;
    const p = this.world.player;
    const nextName = p.turn?.target ?? p.animation;
    this.bank.activateAnimation(p.animation, nextName);
    const queuedName = p.queuedAction?.gesture ?? (p.queuedAction?.face ? `idle-${p.queuedAction.face}` : null);
    // Reconcile every tick: held movement can drop a queued request after its one-shot input.
    if (this.bank.deliveredAnimation && this.bank.deliveredAnimation !== queuedName)
      this.bank.cancelPreparation();
    if (wasAirborne && p.mode === "ground") this.markGround();
    if (this.lastMode !== this.director.mode) {
      this.lastMode = this.director.mode;
      this.onMode?.(this.lastMode);
    }
  }
  frame(now) {
    this.raf = 0;
    if (this.pauses.size || !this.ready) return;
    const elapsed = this.lastTime ? Math.min(0.05, (now - this.lastTime) / 1000) : 1 / 60;
    this.lastTime = now;
    this.accumulator += elapsed;
    this.paintElapsed += elapsed;
    while (this.accumulator >= 1 / 120) {
      this.step(1 / 120);
      this.accumulator -= 1 / 120;
    }
    const p = this.world.player;
    const moving = Math.abs(p.vx) > 0.1 || p.mode !== "ground" || p.turn || this.transition;
    if (moving || this.paintElapsed >= 1 / 24) {
      this.paint(this.paintElapsed);
      this.paintElapsed = moving ? 0 : this.paintElapsed % (1 / 24);
    }
    this.raf = requestAnimationFrame(this.frame);
  }
  alignDrag(pose) {
    if (this.drag && pose) {
      const socket = socketPosition(pose, HEIGHT / 384);
      pose.x += this.drag.socket.x - socket.x;
      pose.y += this.drag.socket.y - socket.y;
    }
    return pose;
  }
  pose() {
    const p = this.world.player;
    const clip = this.bank.clips.get(p.animation);
    // Clamp once when the suspended silhouette arrives, without restarting
    // the animation scheduler or counting a network response as human input.
    if (this.drag && clip && this.drag.boundsClip !== clip) this.moveDrag(this.drag.point, false);
    let index = clip && this.world.frameIndex(clip.frames.length, this.accumulator);
    if (this.drag && clip) {
      if (clip.loop) index = Math.floor(p.animationTime * clip.fps) % clip.frames.length;
      else {
        const [first, last] = clip.hold_loop ?? [60, 80];
        const span = Math.max(1, last - first);
        const phase = (p.animationTime * clip.fps) % (2 * span);
        index = Math.min(
          clip.frames.length - 1,
          Math.floor(first + (phase <= span ? phase : 2 * span - phase)),
        );
      }
    }
    const pose = this.bank.frame(p.animation, index);
    if (!pose) {
      return this.alignDrag(
        this.lastPose
          ? this.lastPose.clip.registration === "ledge" && !p.ledge
            ? { ...this.lastPose }
            : positionPose(this.lastPose, p)
          : null,
      );
    }
    this.bank.activateAnimation(p.animation, p.turn?.target ?? p.animation);
    const positioned = this.alignDrag(positionPose(pose, p));
    const seam =
      p.animation === "rotation" &&
      this.lastPose?.clip.name === "rotation" &&
      (this.lastPose.frame.source_clip !== pose.frame.source_clip ||
        this.lastPose.mirrored !== positioned.mirrored);
    if (this.animationName !== p.animation || seam) {
      if (p.animation === "jump") this.prepare("land");
      if (p.animation === "land") this.prepare("land-rest");
      this.transition =
        this.lastPose &&
        !this.reduced &&
        !["hang", "climb"].includes(p.mode) &&
        !samePoseImage(this.lastPose, positioned)
          ? {
              pose: this.lastPose,
              started: this.world.time,
              playerX: p.x,
              playerY: p.y,
              duration: 0.075,
            }
          : null;
      this.animationName = p.animation;
    }
    this.lastPose = positioned;
    this.bank.retainPoses(this.lastPose, this.transition?.pose);
    return positioned;
  }
  paint(dt) {
    if (!this.ready) return;
    const c = this.context;
    const cfg = this.config;
    const p = this.world.player;
    const ratio = Math.min(devicePixelRatio || 1, 2);
    const zoom = cfg.scale;
    const originY = cfg.floorY - FLOOR * zoom;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);
    c.setTransform(ratio * zoom, 0, 0, ratio * zoom, 0, originY * ratio);
    const pose = this.pose();
    const scale = HEIGHT / 384;
    const blend = this.transition
      ? Math.min(1, (this.world.time - this.transition.started) / this.transition.duration)
      : 1;
    const outgoing = blend < 1 ? transitionPose(this.transition, p) : null;
    const display = pose ? blendAtSocket(pose, outgoing, blend, scale) : null;
    if (!display) return;
    const end = display.endpoint;
    const start = { x: cfg.terminal.x / zoom, y: (cfg.terminal.y - originY) / zoom };
    this.tether.update(dt, start, end, { floor: FLOOR, platforms: this.world.platforms });
    c.strokeStyle = "#000000";
    c.lineWidth = 0.9 / Math.max(1, zoom / 1.5);
    c.lineCap = "round";
    c.lineJoin = "round";
    this.tether.trace(c);
    c.stroke();
    for (const mark of this.groundMarks) c.drawImage(this.dirt, mark.x - 104, mark.y - 5, 208, 13);
    if (!display.outgoing) {
      this.transition = null;
      this.bank.retainPoses(this.lastPose);
    }
    this.renderer.draw(display.incoming, display.outgoing, blend, scale, ratio * zoom);
    // Remove the HTML fallback only once both live artwork and tether exist.
    this.onPaint?.();
    this.onPaint = null;
    const visiblePose = display.incoming;
    const f = visiblePose.frame;
    this.onBounds?.({
      x: (visiblePose.x + (visiblePose.mirrored ? f.anchor.x - f.w : -f.anchor.x) * scale) * zoom,
      y: (visiblePose.y - f.anchor.y * scale) * zoom + originY,
      width: f.w * scale * zoom,
      height: f.h * scale * zoom,
    });
  }
}
