import assert from "node:assert/strict";
import test from "node:test";
import { Tether } from "../tether.mjs";

test("the tether hangs with weight: pinned ends, sag below the chord, bounded length, and it settles", () => {
  const rope = new Tether();
  const start = { x: 500, y: 170 };
  const end = { x: 620, y: 480 };
  for (let i = 0; i < 240; i++) rope.update(1 / 60, start, end);
  const p = rope.points;
  assert.deepEqual([p[0].x, p[0].y, p.at(-1).x, p.at(-1).y], [500, 170, 620, 480]);
  const mid = p[Math.floor(p.length / 2)];
  const chordY = (start.y + end.y) / 2;
  const chordX = (start.x + end.x) / 2;
  assert.ok(
    mid.y > chordY + 5 || Math.abs(mid.x - chordX) > 5,
    "The middle of the rope hangs off the straight line",
  );
  let length = 0;
  for (let i = 1; i < p.length; i++) length += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
  assert.ok(
    Math.abs(length - rope.length(start, end)) < rope.length(start, end) * 0.03,
    "Segments keep their rest length",
  );
  const before = p.map((q) => ({ ...q }));
  rope.update(1 / 60, start, end);
  assert.ok(
    p.every((q, i) => Math.hypot(q.x - before[i].x, q.y - before[i].y) < 0.3),
    "A still rope stays still",
  );
});

test("the tether drapes over the floor and solid blocks instead of passing through them", () => {
  const rope = new Tether();
  const start = { x: 400, y: 200 };
  const end = { x: 100, y: 620 };
  const block = { x: 200, width: 300, top: 460, solid: true };
  const soft = { x: 0, width: 1000, top: 300, solid: false };
  for (let i = 0; i < 300; i++)
    rope.update(1 / 60, start, end, { floor: 620, platforms: [block, soft] });
  for (const q of rope.points.slice(1, -1)) {
    assert.ok(q.y <= 619, "No point sinks below the floor");
    const inside = q.x > block.x - 2 && q.x < block.x + block.width + 2 && q.y > block.top - 2;
    assert.ok(
      !inside,
      `No point rests inside the headline block (${q.x.toFixed(1)}, ${q.y.toFixed(1)})`,
    );
  }
  assert.ok(
    rope.points.some((q) => q.y < soft.top && q.y > 200),
    "One-way letter platforms do not catch the cable",
  );
});

test("the tether survives teleports and odd frame times, and traces a path", () => {
  const rope = new Tether();
  const start = { x: 0, y: 0 };
  rope.update(0, start, { x: 100, y: 200 });
  rope.update(0.5, start, { x: 900, y: 200 });
  rope.update(1 / 240, start, { x: -300, y: 50 });
  assert.ok(rope.points.every((q) => Number.isFinite(q.x) && Number.isFinite(q.y)));
  const calls = [];
  const c = new Proxy(
    {},
    {
      get:
        (_, name) =>
        (..._args) =>
          calls.push(name),
    },
  );
  rope.trace(c);
  assert.equal(calls[0], "beginPath");
  assert.ok(calls.includes("quadraticCurveTo"));
  new Tether().trace(c);
});
