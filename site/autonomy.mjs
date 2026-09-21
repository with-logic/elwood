/** Automatic movement and task-owned preparation (docs/design/landing.md). */
const MOMENTS = [
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
];

const PREPARATION_SECONDS = 30; // Complete clips include idle, rotation and every gesture sheet.

export const NO_INPUT = Object.freeze({});

export class Autonomy {
  constructor({ random = Math.random, ready = () => true, fits = () => true, onTaskEnd = () => {} } = {}) {
    this.random = random;
    this.ready = ready;
    this.fits = fits;
    this.onTaskEnd = onTaskEnd;
    this.mode = "auto";
    this.quiet = 0;
    this.task = { kind: "rest", remaining: 5 };
    this.lastMoment = null;
    this.settling = false;
    this.restingFor = 0;
  }
  get task() { return this.currentTask; }
  set task(task) {
    const previous = this.currentTask;
    this.currentTask = task;
    if (previous && previous !== task) this.onTaskEnd(previous);
  }
  between(low, high) {
    return low + this.random() * (high - low);
  }
  interact() {
    this.mode = "manual";
    this.quiet = 0;
    this.task = null;
    this.settling = false;
    this.restingFor = 0;
  }
  resume(delay = 0.4) {
    this.mode = "auto";
    this.quiet = 0;
    this.task = { kind: "rest", remaining: delay };
  }
  rest() {
    this.task = { kind: "rest", remaining: this.random() < 0.35 ? 0.15 : this.between(1.2, 4) };
  }

  choose(world, bounds) {
    const p = world.player;
    const choice = this.random();
    const higher = world.platforms.filter(
      (s) =>
        s.top >= (bounds.top ?? Number.NEGATIVE_INFINITY) &&
        s.top < p.y - 15 &&
        s.top > p.y - 170 &&
        s.x + s.width > bounds.left &&
        s.x < bounds.right,
    );
    if (higher.length && choice < 0.22) {
      const platform = higher[Math.floor(this.random() * higher.length)];
      this.task = {
        kind: "walk",
        x: Math.max(bounds.left, Math.min(bounds.right, platform.x + platform.width * 0.7)),
        platform,
        elapsed: 0,
        stuck: 0,
        lastX: p.x,
        jumpIn: 0,
      };
    } else if (choice < 0.48 && bounds.right - bounds.left > 25) {
      let target = this.between(bounds.left, bounds.right);
      if (Math.abs(target - p.x) < 35)
        target = p.x < (bounds.left + bounds.right) / 2 ? bounds.right : bounds.left;
      this.task = { kind: "walk", x: target, elapsed: 0, stuck: 0, lastX: p.x, jumpIn: 0 };
    } else if (choice > 0.9) {
      this.task = {
        kind: "face",
        direction: this.random() < 0.5 ? "front" : "back",
        elapsed: 0,
        sent: false,
      };
    } else {
      const choices = MOMENTS.filter((name) => {
        const clip = world.clips[name];
        if (!clip || name === this.lastMoment) return false;
        const travel =
          clip.travel_speed?.reduce((sum, speed) => sum + speed / 24, 0) ??
          (name === "tiptoe" ? 216 : 0);
        const destination = p.x + travel * p.facing;
        return destination >= bounds.left && destination <= bounds.right;
      });
      if (!choices.length) {
        this.rest();
        return;
      }
      const name = choices[Math.floor(this.random() * choices.length)];
      this.lastMoment = name;
      this.task = {
        kind: "moment",
        name,
        sent: false,
        seen: false,
        elapsed: 0,
        hold: this.between(2.5, 9),
      };
    }
  }

  update(dt, world, bounds, active = false) {
    const p = world.player;
    if (active) {
      this.interact();
      return NO_INPUT;
    }
    if (this.mode === "manual") {
      this.quiet += dt;
      if (p.mode === "hang" && this.quiet >= 5) return { climbPressed: true };
      if (p.gesture)
        return this.quiet >= 5 && p.gestureStage === "hold" ? { releaseGesture: true } : NO_INPUT;
      if (p.mode !== "ground" || p.turn || Math.abs(p.vx) > 1 || p.landing || p.prepare || p.settle)
        return NO_INPUT;
      if (!this.settling && this.quiet >= 5) {
        this.settling = true;
        return { idle: true };
      }
      if (p.animation === "idle") this.restingFor += dt;
      if (this.quiet < 5 || this.restingFor < 3.5) return NO_INPUT;
      this.resume();
    }
    if (!this.task) this.choose(world, bounds);
    const task = this.task;
    if (!task) return NO_INPUT;
    if (task.kind === "rest") {
      task.remaining -= dt;
      if (task.remaining <= 0 && p.mode === "ground" && !p.turn && !p.gesture) this.task = null;
      return NO_INPUT;
    }
    task.elapsed += dt;
    if (task.kind !== "walk" && !task.sent && task.elapsed > PREPARATION_SECONDS) {
      this.rest();
      return NO_INPUT;
    }
    if (task.kind === "walk") {
      task.jumpIn = Math.max(0, task.jumpIn - dt);
      if (p.mode === "hang") return { climbPressed: true };
      if (p.mode === "climb") return NO_INPUT;
      const distance = task.x - p.x;
      const arrived =
        Math.abs(distance) < 5 && (!task.platform || p.support?.id === task.platform.id);
      if (arrived || task.elapsed > 12) {
        this.rest();
        return NO_INPUT;
      }
      task.stuck = Math.abs(p.x - task.lastX) < 0.02 && !p.turn ? task.stuck + dt : 0;
      task.lastX = p.x;
      const climbTarget = task.platform && task.platform.top < p.y - 10 && Math.abs(distance) < 100;
      const jump =
        p.mode === "ground" && !p.turn && task.jumpIn === 0 && (climbTarget || task.stuck > 0.5);
      if (jump) task.jumpIn = 1.6;
      return {
        axis: Math.abs(distance) < 4 ? 0 : Math.sign(distance),
        climbHeld: true,
        jumpPressed: jump,
      };
    }
    if (task.kind === "face") {
      if (!task.sent && this.ready(`idle-${task.direction}`, task)) {
        task.sent = true;
        task.elapsed = 0;
        return { face: task.direction };
      }
      if (task.sent && !p.turn && task.elapsed > 1.4) this.rest();
      return NO_INPUT;
    }
    if (!task.sent) {
      if (p.mode === "ground") {
        // null means the geometry metadata is still loading. Reject a trick
        // before requesting its much larger image page when it will not fit.
        task.fits ??= this.fits(task.name, world);
        if (task.fits === false) {
          this.rest();
          return NO_INPUT;
        }
        if (task.fits && this.ready(task.name, task)) {
          task.sent = true;
          task.elapsed = 0;
          return { gesture: task.name };
        }
      }
      return NO_INPUT;
    }
    if (p.gesture === task.name) {
      task.seen = true;
      if (p.gestureStage === "hold") {
        task.hold -= dt;
        if (task.hold <= 0) return { releaseGesture: true };
      }
    } else if (task.seen || task.elapsed > 15) this.rest();
    return NO_INPUT;
  }
}
