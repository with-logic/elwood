/** Release a bitmap or HTML image after its last owner (PRD §13; site/docs/design/landing.md). */
export function releaseSpriteImage(image) {
  if (typeof image.close === "function") image.close();
  else image.removeAttribute?.("src");
}
