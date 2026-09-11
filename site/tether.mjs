// The cable between the terminal and the robot: a short verlet rope with
// gravity, damping and distance constraints, pinned at both ends. It sags,
// swings and settles like a real lead instead of tracing a fixed curve.
export class Tether {
  constructor({ segments = 22, gravity = 900, slack = 24, stretch = 0.025 } = {}) {
    this.segments = segments;
    this.gravity = gravity;
    this.slack = slack;
    this.stretch = stretch;
    this.points = null;
    this.rest = 0;
  }
  reset(start, end) {
    this.points = Array.from({ length: this.segments + 1 }, (_, i) => {
      const t = i / this.segments;
      const x = start.x + (end.x - start.x) * t;
      const y = start.y + (end.y - start.y) * t;
      return { x, y, px: x, py: y };
    });
    this.settle(start, end, 60);
  }
  length(start, end) {
    const distance = Math.hypot(end.x - start.x, end.y - start.y);
    return distance + this.slack + distance * this.stretch;
  }
  // Fixed substeps keep the rope stable whatever the frame rate, and clamp the
  // endpoint jumps a teleport (reset, layout change) would otherwise whip in.
  update(dt, start, end, obstacles = null) {
    if (!this.points) this.reset(start, end);
    const steps = Math.max(1, Math.min(6, Math.ceil(dt / (1 / 120))));
    const h = Math.min(dt, 0.1) / steps;
    this.rest = this.length(start, end) / this.segments;
    for (let s = 0; s < steps; s++) this.step(h, start, end, obstacles);
    return this.points;
  }
  // The cable drapes over the floor and any solid block (the wide poster's
  // headline) instead of passing through the lettering.
  collide(obstacles) {
    const p = this.points;
    const n = p.length - 1;
    for (let i = 1; i < n; i++) {
      const q = p[i];
      if (obstacles.floor !== undefined) q.y = Math.min(obstacles.floor - 1, q.y);
      for (const block of obstacles.platforms ?? []) {
        if (
          block.solid !== true ||
          q.x <= block.x - 2 ||
          q.x >= block.x + block.width + 2 ||
          q.y <= block.top - 2
        )
          continue;
        const left = q.x - block.x;
        const right = block.x + block.width - q.x;
        const top = q.y - block.top;
        const closest = Math.min(left, right, top);
        if (closest === top) q.y = block.top - 2;
        else if (closest === left) q.x = block.x - 2;
        else q.x = block.x + block.width + 2;
      }
    }
  }
  step(h, start, end, obstacles = null) {
    const p = this.points;
    const n = p.length - 1;
    const g = this.gravity * h * h;
    for (let i = 1; i < n; i++) {
      const q = p[i];
      const vx = (q.x - q.px) * 0.97;
      const vy = (q.y - q.py) * 0.97;
      q.px = q.x;
      q.py = q.y;
      q.x += vx;
      q.y += vy + g;
    }
    for (let k = 0; k < 8; k++) {
      p[0].x = start.x;
      p[0].y = start.y;
      p[n].x = end.x;
      p[n].y = end.y;
      for (let i = 0; i < n; i++) {
        const a = p[i];
        const b = p[i + 1];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 1e-6;
        const pull = (d - this.rest) / d / 2;
        const wa = i === 0 ? 0 : 1;
        const wb = i + 1 === n ? 0 : 1;
        const share = wa + wb || 1;
        a.x += (dx * pull * 2 * wa) / share;
        a.y += (dy * pull * 2 * wa) / share;
        b.x -= (dx * pull * 2 * wb) / share;
        b.y -= (dy * pull * 2 * wb) / share;
      }
      if (obstacles) this.collide(obstacles);
    }
    p[0].x = start.x;
    p[0].y = start.y;
    p[n].x = end.x;
    p[n].y = end.y;
  }
  settle(start, end, iterations) {
    this.rest = this.length(start, end) / this.segments;
    for (let i = 0; i < iterations; i++) this.step(1 / 60, start, end);
  }
  trace(c) {
    const p = this.points;
    if (!p) return;
    c.beginPath();
    c.moveTo(p[0].x, p[0].y);
    for (let i = 1; i < p.length - 1; i++)
      c.quadraticCurveTo(p[i].x, p[i].y, (p[i].x + p[i + 1].x) / 2, (p[i].y + p[i + 1].y) / 2);
    c.lineTo(p.at(-1).x, p.at(-1).y);
  }
}
