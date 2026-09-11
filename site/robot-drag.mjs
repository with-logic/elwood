export function bindRobotDrag(scene, grip) {
  let pointer = null;
  const point = (event) => scene.worldPoint(event.clientX, event.clientY);
  function release() {
    const released = pointer;
    pointer = null;
    if (released !== null && grip.hasPointerCapture(released)) grip.releasePointerCapture(released);
    scene.endDrag();
    grip.setAttribute("aria-pressed", "false");
  }
  grip.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || pointer !== null) return;
    if (!scene.beginDrag(point(event))) return;
    event.preventDefault();
    pointer = event.pointerId;
    grip.setPointerCapture(pointer);
    grip.setAttribute("aria-pressed", "true");
  });
  grip.addEventListener("pointermove", (event) => {
    if (event.pointerId === pointer) scene.moveDrag(point(event));
  });
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"])
    grip.addEventListener(name, (event) => {
      if (event.pointerId === pointer) release();
    });
  grip.addEventListener("click", (event) => {
    if (event.detail !== 0) return;
    if (scene.dragging) {
      release();
      return;
    }
    const rect = grip.getBoundingClientRect();
    if (scene.beginDrag(scene.worldPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)))
      grip.setAttribute("aria-pressed", "true");
  });
  grip.addEventListener("keydown", (event) => {
    if (!scene.dragging) return;
    const steps = {
      ArrowLeft: [-12, 0],
      ArrowRight: [12, 0],
      ArrowUp: [0, -12],
      ArrowDown: [0, 12],
    };
    if (steps[event.code]) {
      event.preventDefault();
      event.stopPropagation();
      scene.nudgeDrag(...steps[event.code]);
    }
    if (event.code === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      release();
    }
  });
  window.addEventListener("blur", release);
  return release;
}
