/** Exercises poster geometry from docs/design/landing.md; browser QA checks real font metrics. */
import assert from "node:assert/strict";
import test from "node:test";
import { fitTitle, layoutPoster } from "../landing/layout.mjs";
import { HEIGHT } from "../world.mjs";

function mobilePoster(width, height, lineHeight = 0.95) {
  const hero = {
    clientWidth: width,
    clientHeight: height,
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
  };
  const words = [4.2, 5.8, 2.8, 4.1].map((letters) => ({
    style: {},
    getBoundingClientRect() {
      const size = Number.parseFloat(this.style.fontSize) || 48;
      const index = words.indexOf(this);
      const top =
        title.getBoundingClientRect().top +
        words
          .slice(0, index)
          .reduce(
            (sum, word) => sum + (Number.parseFloat(word.style.fontSize) || 48) * lineHeight,
            0,
          );
      const wordWidth = size * letters;
      return {
        left: (width - wordWidth) / 2,
        top,
        width: wordWidth,
        height: size * lineHeight,
        right: (width + wordWidth) / 2,
        bottom: top + size * lineHeight,
      };
    },
  }));
  const title = {
    clientWidth: width - 40,
    querySelectorAll: () => words,
    getBoundingClientRect() {
      const titleHeight = words.reduce(
        (sum, word) => sum + (Number.parseFloat(word.style.fontSize) || 48) * lineHeight,
        0,
      );
      return {
        left: 20,
        top: height - 110 - titleHeight,
        width: width - 40,
        height: titleHeight,
        bottom: height - 110,
      };
    },
  };
  const terminal = {
    getBoundingClientRect: () => ({
      left: (width - 114) / 2,
      top: 124,
      bottom: 124 + 114 / 1.45,
      width: 114,
    }),
  };
  const scene = {
    configure(config) {
      this.config = config;
    },
  };
  const poster = { style: {} };
  const rope = { style: {} };
  return { hero, title, terminal, scene, poster, rope, words };
}

globalThis.getComputedStyle = (element) => ({ fontSize: element.style.fontSize || "48px" });

for (const [width, height] of [
  [320, 700],
  [375, 700],
  [390, 844],
  [430, 932],
  [600, 980],
]) {
  test(`mobile poster at ${width} × ${height} leaves room for the robot and visible cable`, () => {
    const { hero, title, terminal, scene, poster, rope, words } = mobilePoster(width, height);
    fitTitle(hero, title);
    layoutPoster({ hero, title, terminal, scene, poster, rope });
    assert.ok(title.getBoundingClientRect().height <= Math.min(height * 0.26, 220) + 0.01);
    assert.ok(
      words.every((word) => word.getBoundingClientRect().width <= title.clientWidth + 0.01),
    );
    const robotTop = Number.parseFloat(poster.style.top);
    const robotHeight = Number.parseFloat(poster.style.height);
    assert.ok(robotTop - terminal.getBoundingClientRect().bottom >= 64 - 0.01);
    assert.ok(robotHeight > 0);
    assert.equal(scene.config.scale * HEIGHT, robotHeight);
    assert.equal(robotTop + robotHeight, title.getBoundingClientRect().top - 2);
    assert.ok(Number.parseFloat(rope.style.height) >= 60 - 0.01);
    assert.equal(
      Number.parseFloat(rope.style.top) + Number.parseFloat(rope.style.height),
      robotTop,
    );
  });
}

test("mobile fitting measures taller fallback-font lines and stays stable when repeated", () => {
  const { hero, title } = mobilePoster(375, 700, 1.2);
  fitTitle(hero, title);
  const fittedHeight = title.getBoundingClientRect().height;
  assert.ok(Math.abs(fittedHeight - 182) < 0.01);
  fitTitle(hero, title);
  assert.ok(Math.abs(title.getBoundingClientRect().height - fittedHeight) < 0.01);
});

test("tight layouts shrink the robot below its former 120px floor instead of overlapping", () => {
  const { hero, title, terminal, scene, poster, rope } = mobilePoster(320, 620);
  fitTitle(hero, title);
  layoutPoster({ hero, title, terminal, scene, poster, rope });
  assert.ok(Number.parseFloat(poster.style.height) < 120);
  assert.ok(Number.parseFloat(poster.style.top) >= terminal.getBoundingClientRect().bottom + 64);
});
