/** Advance a World in the fixed 120 Hz steps the site tests share; `each` sees the player after every step. */
export function stepWorld(world, seconds, input = {}, each = () => {}) {
  for (let index = 0; index < Math.round(seconds * 120); index++) {
    world.update(1 / 120, input);
    each(world.player);
  }
}
