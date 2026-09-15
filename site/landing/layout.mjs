/** Fits the poster lettering and artwork without collisions; docs/design/landing.md. */
import { FLOOR, HEIGHT } from "../world.mjs";

export function fitTitle(hero, title) {
  const mobile = hero.clientWidth <= 600;
  for (const element of title.querySelectorAll(".title-line, .word")) element.style.fontSize = "";
  // Each line (each word on phones) fills the poster width; the whole block
  // then shrinks uniformly if it would crowd the robot out of the hero.
  const units = [...title.querySelectorAll(mobile ? ".word" : ".title-line")];
  const sizes = units.map((element) => {
    const natural = element.getBoundingClientRect().width;
    const base = Number.parseFloat(getComputedStyle(element).fontSize);
    return natural > 0 && base > 0 ? (base * title.clientWidth) / natural : 0;
  });
  const height = sizes.reduce((sum, size) => sum + size * 0.9, 0);
  const shrink =
    !mobile && height > hero.clientHeight * 0.25 ? (hero.clientHeight * 0.25) / height : 1;
  units.forEach((element, i) => {
    if (sizes[i]) element.style.fontSize = `${sizes[i] * shrink}px`;
  });
  if (mobile) {
    // Measure real line height and padding after fitting, including fallback fonts.
    const measured = title.getBoundingClientRect().height;
    const limit = Math.min(hero.clientHeight * 0.26, 220);
    if (measured > limit)
      for (const element of units)
        element.style.fontSize = `${(Number.parseFloat(element.style.fontSize) * limit) / measured}px`;
  }
}

export function layoutPoster({ hero, title, terminal, scene, poster, rope }) {
  const rect = hero.getBoundingClientRect();
  const term = terminal.getBoundingClientRect();
  // The headline block is a solid ledge: he stands on it,
  // can walk off either side to the baseline, and climbs back up. He stays a
  // little shorter than the block so the climb reads, with cable to spare.
  // Measure the lettering from the words themselves: the line wrappers have
  // no box of their own on phones, where each word sits on its own row.
  const titleBox = title.getBoundingClientRect();
  const lineBox = [...title.querySelectorAll(".word")]
    .map((word) => word.getBoundingClientRect())
    .reduce(
      (box, b) =>
        b.width > 0
          ? {
              left: Math.min(box.left, b.left),
              right: Math.max(box.right, b.right),
              top: Math.min(box.top, b.top),
              bottom: Math.max(box.bottom, b.bottom),
            }
          : box,
      {
        left: Number.POSITIVE_INFINITY,
        right: Number.NEGATIVE_INFINITY,
        top: Number.POSITIVE_INFINITY,
        bottom: Number.NEGATIVE_INFINITY,
      },
    );
  if (!(lineBox.right > lineBox.left))
    Object.assign(lineBox, {
      left: titleBox.left,
      right: titleBox.left + titleBox.width,
      top: titleBox.top,
      bottom: titleBox.bottom,
    });
  lineBox.width = lineBox.right - lineBox.left;
  // He stands a hair above the lettering rather than on the ink itself.
  const lift = 2;
  const headingHeight = lineBox.bottom - lineBox.top + lift;
  const floorY = lineBox.bottom - rect.top;
  const clearance = rect.width <= 600 ? 64 : 95;
  const room = Math.max(1, floorY - headingHeight - (term.bottom - rect.top) - clearance);
  const robotHeight = Math.min(260, Math.max(165, rect.width * 0.17), room, headingHeight * 0.9);
  const scale = robotHeight / HEIGHT;
  const robotX = rect.width * 0.5;
  const platforms =
    headingHeight > 0
      ? [
          {
            id: "heading",
            x: (lineBox.left - rect.left) / scale,
            width: lineBox.width / scale,
            top: FLOOR - headingHeight / scale,
            solid: true,
          },
        ]
      : [];
  scene.configure({
    width: rect.width,
    height: rect.height,
    scale,
    floorY,
    robotX,
    terminal: { x: term.left - rect.left + term.width / 2, y: term.bottom - rect.top + 4 },
    platforms,
  });
  poster.style.height = `${robotHeight}px`;
  poster.style.left = `${robotX}px`;
  poster.style.top = `${floorY - headingHeight - robotHeight}px`;
  poster.style.bottom = "auto";
  const startY = term.bottom - rect.top + 4;
  rope.style.top = `${startY}px`;
  rope.style.height = `${Math.max(0, floorY - headingHeight - robotHeight - startY)}px`;
}
