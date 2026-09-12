import { LandingScene } from "./landing-scene.mjs";
import { bindRobotDrag } from "./robot-drag.mjs";
import { FLOOR, HEIGHT } from "./world.mjs";

const hero = document.querySelector(".hero");
const canvas = document.querySelector("#elwood-scene");
const dialog = document.querySelector("#robot-help");
const title = document.querySelector(".hero-title");
const terminal = document.querySelector(".terminal");
const errorLabel = document.querySelector(".robot-error");
const pauseButtons = [
  ...document.querySelectorAll('[data-action="pause"], [data-command="pause"]'),
];
const grip = document.querySelector(".robot-grip");
const keys = new Set();
const pointerKeys = new Set();
const codes = new Set();
let resizing = false;
let booted = false;
let visible = true;
let previousFocus = null;

const scene = new LandingScene(canvas, {
  onReady() {
    hero.dataset.ready = "";
    grip.hidden = false;
    resize();
  },
  onBounds(box) {
    grip.style.transform = `translate(${box.x}px, ${box.y}px)`;
    grip.style.width = `${box.width}px`;
    grip.style.height = `${box.height}px`;
    grip.setAttribute("aria-pressed", String(scene.dragging));
  },
  onError(error) {
    errorLabel.textContent = error.message;
    errorLabel.hidden = false;
  },
  onMode(mode) {
    if (mode === "manual") hero.dataset.manual = "";
    else delete hero.dataset.manual;
  },
});

bindRobotDrag(scene, grip);

function fitTitle() {
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
  const limit = hero.clientHeight * (mobile ? 0.36 : 0.25);
  const shrink = height > limit ? limit / height : 1;
  units.forEach((element, i) => {
    if (sizes[i]) element.style.fontSize = `${sizes[i] * shrink}px`;
  });
}
function resize() {
  if (resizing) return;
  resizing = true;
  fitTitle();
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
              right: Math.max(box.right ?? Number.NEGATIVE_INFINITY, b.right ?? b.left + b.width),
              top: Math.min(box.top, b.top),
              bottom: Math.max(
                box.bottom ?? Number.NEGATIVE_INFINITY,
                b.bottom ?? b.top + b.height,
              ),
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
      bottom: titleBox.bottom ?? titleBox.top + titleBox.height,
    });
  lineBox.width = lineBox.right - lineBox.left;
  // He stands a hair above the lettering rather than on the ink itself.
  const lift = 2;
  const headingHeight = lineBox.bottom - lineBox.top + lift;
  const floorY = lineBox.bottom - rect.top;
  const room = Math.max(120, floorY - headingHeight - (term.bottom - rect.top) - 95);
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
  const still = document.querySelector(".robot-poster");
  still.style.height = `${robotHeight}px`;
  still.style.left = `${robotX}px`;
  still.style.top = `${floorY - headingHeight - robotHeight}px`;
  still.style.bottom = "auto";
  resizing = false;
}
function updateHeld() {
  const held = new Set([...keys, ...pointerKeys]);
  scene.axis = Number(held.has("right")) - Number(held.has("left"));
  scene.climbHeld = held.has("climb");
  scene.sprint = held.has("sprint") || codes.has("ShiftLeft") || codes.has("ShiftRight");
}
function clearHeld() {
  codes.clear();
  keys.clear();
  pointerKeys.clear();
  scene.clearInput();
}
function pauseLabel() {
  const paused = scene.userPaused;
  for (const button of pauseButtons) {
    const label = button.querySelector("span");
    if (label) label.textContent = paused ? "Resume" : "Pause";
    else button.textContent = paused ? "Resume animation" : "Pause animation";
  }
}
function togglePaused() {
  scene.toggleUserPause();
  clearHeld();
  pauseLabel();
}
function openHelp() {
  if (dialog.open) return;
  previousFocus = document.activeElement;
  scene.pause("help", true);
  clearHeld();
  pauseLabel();
  dialog.showModal();
}
function closeHelp() {
  if (dialog.open) dialog.close();
}
dialog.addEventListener("close", () => {
  scene.pause("help", false);
  previousFocus?.focus({ preventScroll: true });
});
document.querySelector(".help-toggle").addEventListener("click", openHelp);
document.querySelector(".help-close").addEventListener("click", closeHelp);
dialog.addEventListener("click", (event) => {
  if (event.target === dialog) {
    const rect = dialog.getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    )
      closeHelp();
  }
});
function play() {
  closeHelp();
  hero.scrollIntoView({ block: "start", behavior: "instant" });
  scene.resumePlayback();
  scene.interact();
}
document.querySelector('[data-action="play"]').addEventListener("click", play);
for (const button of pauseButtons) button.addEventListener("click", togglePaused);
for (const button of document.querySelectorAll('[data-command="reset"]'))
  button.addEventListener("click", () => {
    closeHelp();
    scene.home();
  });
for (const button of document.querySelectorAll("[data-gesture]"))
  button.addEventListener("click", () => {
    play();
    scene.request({ gesture: button.dataset.gesture });
  });
for (const button of document.querySelectorAll("[data-face]"))
  button.addEventListener("click", () => {
    play();
    scene.request({ face: button.dataset.face });
  });
for (const button of document.querySelectorAll("[data-hold], [data-press]")) {
  const press = () => {
    play();
    scene.interact();
    if (button.dataset.hold) {
      pointerKeys.add(button.dataset.hold);
      updateHeld();
      if (button.dataset.hold === "climb") scene.request({ climbPressed: true });
    } else scene.request({ [`${button.dataset.press}Pressed`]: true });
  };
  const release = () => {
    pointerKeys.delete(button.dataset.hold);
    updateHeld();
  };
  button.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    press();
  });
  for (const name of ["pointerup", "pointercancel", "lostpointercapture", "blur"])
    button.addEventListener(name, release);
  button.addEventListener("keydown", (event) => {
    if (["Space", "Enter"].includes(event.code)) {
      event.preventDefault();
      if (!event.repeat) press();
    }
  });
  button.addEventListener("keyup", (event) => {
    if (["Space", "Enter"].includes(event.code)) {
      event.preventDefault();
      release();
    }
  });
}
const movement = {
  ArrowLeft: "left",
  KeyA: "left",
  ArrowRight: "right",
  KeyD: "right",
  ArrowUp: "climb",
  KeyW: "climb",
  KeyE: "climb",
};
const gestures = new Map(
  [...document.querySelectorAll("[data-gesture][data-code]")].map((button) => [
    button.dataset.code,
    button.dataset.gesture,
  ]),
);
window.addEventListener("keydown", (event) => {
  if (
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    event.target.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName)
  )
    return;
  if (document.querySelector("#terminal-demo").open) return;
  if (event.key === "?") {
    event.preventDefault();
    if (!event.repeat) dialog.open ? closeHelp() : openHelp();
    return;
  }
  if (dialog.open || !visible) return;
  if (
    ["BUTTON", "A", "SUMMARY"].includes(event.target.tagName) &&
    ["Space", "Enter"].includes(event.code)
  )
    return;
  if (scene.dragging) return;
  if (event.code === "ShiftLeft" || event.code === "ShiftRight") {
    if (!scene.manuallyPaused) {
      codes.add(event.code);
      updateHeld();
    }
    return;
  }
  const action = movement[event.code];
  if (
    !(
      action ||
      ["Space", "ArrowDown", "KeyS", "KeyF", "KeyB", "KeyR", "KeyP"].includes(event.code) ||
      gestures.has(event.code)
    )
  )
    return;
  event.preventDefault();
  if (event.repeat) return;
  if (event.code === "KeyP") {
    togglePaused();
    return;
  }
  if (event.code === "KeyR") {
    scene.home();
    return;
  }
  if (scene.manuallyPaused) return;
  scene.interact();
  if (action) {
    codes.add(event.code);
    keys.add(action);
    updateHeld();
    if (action === "climb") scene.request({ climbPressed: true });
  }
  if (event.code === "Space") scene.request({ jumpPressed: true });
  if (event.code === "ArrowDown" || event.code === "KeyS") scene.request({ dropPressed: true });
  if (event.code === "KeyF") scene.request({ face: "front" });
  if (event.code === "KeyB") scene.request({ face: "back" });
  if (gestures.has(event.code)) scene.request({ gesture: gestures.get(event.code) });
});
window.addEventListener("keyup", (event) => {
  codes.delete(event.code);
  const action = movement[event.code];
  if (action && ![...codes].some((code) => movement[code] === action)) keys.delete(action);
  updateHeld();
});
window.addEventListener("blur", () => {
  codes.clear();
  clearHeld();
  scene.pause("blur", true);
});
window.addEventListener("focus", () => scene.pause("blur", false));
document.addEventListener("visibilitychange", () => {
  codes.clear();
  clearHeld();
  scene.pause("hidden", document.hidden);
});
new ResizeObserver(resize).observe(hero);
new IntersectionObserver(
  (entries) => {
    visible = entries[0].isIntersecting;
    scene.pause("offscreen", !visible);
    if (visible && !booted) {
      booted = true;
      scene.boot();
    }
  },
  { threshold: 0.05 },
).observe(hero);
document.fonts.ready.then(resize);
resize();

// The install command is the one thing most visitors want to take with them.
for (const button of document.querySelectorAll(".install-copy")) {
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.command);
      button.textContent = "Copied";
    } catch {
      button.textContent = "Copy failed";
    }
    setTimeout(() => {
      button.textContent = "Copy";
    }, 2000);
  });
}

let terminalDemo;
terminal.addEventListener("click", async () => {
  try {
    terminalDemo ??= import("./terminal-demo.mjs")
      .then(({ createTerminalDemo }) =>
        createTerminalDemo({
          onOpen() {
            clearHeld();
            scene.pause("demo", true);
          },
          onClose() {
            scene.pause("demo", false);
          },
        }),
      )
      .catch((error) => {
        terminalDemo = null;
        throw error;
      });
    (await terminalDemo).open(terminal.getBoundingClientRect());
  } catch {
    errorLabel.textContent = "The walkthrough could not load. Click the terminal to retry.";
    errorLabel.hidden = false;
  }
});
