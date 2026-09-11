const code = `import { ClaudeSession } from "@with-logic/elwood";

const session = new ClaudeSession();
try {
  for await (const event of session.stream(
    "Where does this app handle authentication?",
  )) {
    if (event.type === "text") console.log(event.text);
  }
} finally {
  await session.close();
}`;

export const CHAPTERS = [
  {
    title: "Ask from your shell",
    steps: [
      { text: "$ npm install -g @with-logic/elwood", type: true },
      { text: '\n$ elwood "Explain this project."', type: true },
      {
        text: "\n# Elwood is now driving a full Claude Code session, headless, in a hidden terminal.",
        type: true,
        speed: 44,
      },
      {
        text: "\n\nThis app has a small HTTP server, a session layer,\nand a React frontend. The entry point is src/server.ts.",
        hold: 4,
      },
    ],
  },
  {
    title: "Bring your own context",
    steps: [
      {
        text: '$ git diff | elwood "Review this diff for correctness."',
        type: true,
        replace: true,
      },
      {
        text: "\n\nOne issue in src/session.ts:42:\nThe timeout path leaves a subscription attached.\nMove cleanup into finally so both paths release it.",
        hold: 5,
      },
    ],
  },
  {
    title: "Write a tiny TypeScript app",
    steps: [
      { text: "$ npm install @with-logic/elwood\n$ vim ask.mts", type: true, replace: true },
      { text: code, type: true, replace: true, mode: "vim / ask.mts", speed: 65 },
      { text: "\n\n-- INSERT --", hold: 2, mode: "vim / ask.mts" },
      { text: "\n:wq", type: true, mode: "vim / ask.mts" },
      { text: "$ node ask.mts", type: true, replace: true },
      {
        text: "\n\nAuthentication starts in src/auth.ts.\nThe session middleware validates the cookie before\nthe route handler runs.",
        hold: 5,
      },
    ],
  },
  {
    title: "Make it part of a pipeline",
    steps: [
      {
        text: '$ elwood --output json \\\n  "Which module owns authentication?"',
        type: true,
        replace: true,
      },
      {
        text: '\n\n{\n  "schemaVersion": 1,\n  "type": "result",\n  "agent": "claude",\n  "response": "src/auth.ts owns authentication.",\n  "sessionId": null,\n  "durationMs": 2841,\n  "cleanup": { "action": "teardown", "status": "succeeded" }\n}',
        hold: 6,
      },
    ],
  },
];

let offset = 0;
let screen = "";
export const TIMELINE = CHAPTERS.flatMap((chapter, index) =>
  chapter.steps.map((step) => {
    const duration = step.type
      ? Math.max(0.8, step.text.length / (step.speed ?? 32)) + 0.5
      : step.hold;
    const item = {
      ...step,
      chapter: index,
      start: offset,
      end: offset + duration,
      base: step.replace ? "" : screen,
    };
    screen = item.base + step.text;
    offset = item.end;
    return item;
  }),
);
export const DURATION = offset;
export function demoFrame(seconds) {
  const time = Math.max(0, Math.min(DURATION, seconds));
  const step = TIMELINE.find((item) => time < item.end) ?? TIMELINE.at(-1);
  const typed = step.type
    ? Math.min(step.text.length, Math.floor((time - step.start) * (step.speed ?? 32)))
    : step.text.length;
  return {
    text: step.base + step.text.slice(0, typed),
    chapter: step.chapter,
    mode: step.mode ?? "zsh",
    done: time === DURATION,
  };
}

// A little color, not a full grammar: shell prompts, flags and strings; JSON
// keys and values in output; TypeScript keywords inside the Vim chapter.
const escapeHtml = (text) =>
  text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const span = (kind, text) => `<span class="tk-${kind}">${escapeHtml(text)}</span>`;
function tokenize(line, rules) {
  let html = "";
  let rest = line;
  while (rest) {
    let best = null;
    for (const [kind, pattern] of rules) {
      const match = pattern.exec(rest);
      if (match && (!best || match.index < best.index))
        best = { kind, index: match.index, text: match[0] };
      if (best?.index === 0) break;
    }
    if (!best) {
      html += escapeHtml(rest);
      break;
    }
    html += escapeHtml(rest.slice(0, best.index)) + span(best.kind, best.text);
    rest = rest.slice(best.index + best.text.length);
  }
  return html;
}
const SHELL = [
  ["str", /"[^"]*"?/],
  ["flag", /(?:^|(?<=\s))-{1,2}[\w-]+/],
  ["op", /[|\\]|(?<=\s)-g(?=\s|$)/],
];
const OUTPUT = [
  ["key", /"[^"]*"(?=:)/],
  ["str", /"[^"]*"/],
  ["num", /\b\d+(?:\.\d+)?\b|\bnull\b/],
  ["punc", /[{}[\],]/],
];
const TS = [
  ["str", /"[^"]*"?/],
  ["kw", /\b(?:import|from|const|new|try|for|await|of|if|finally)\b/],
  ["type", /\bClaudeSession\b/],
  ["punc", /[{}()[\];,.]/],
];
export function highlight(text, mode = "zsh") {
  if (mode.startsWith("vim")) {
    return text
      .split("\n")
      .map((line) =>
        line === "-- INSERT --"
          ? span("vim", line)
          : line.startsWith(":")
            ? span("ex", line)
            : tokenize(line, TS),
      )
      .join("\n");
  }
  let command = false;
  return text
    .split("\n")
    .map((line) => {
      if (line.startsWith("#")) {
        command = false;
        return span("comment", line);
      }
      if (line.startsWith("$ ") || line === "$") {
        command = line.endsWith("\\");
        const body = line.slice(2);
        const name = /^[\w@/.-]+/.exec(body);
        const pipe = /^(git \S+\s*\|\s*)/.exec(body);
        const prefix = pipe
          ? tokenize(pipe[1], [
              ["op", /\|/],
              ["cmd", /^git/],
            ])
          : name
            ? span("cmd", name[0])
            : "";
        const used = pipe ? pipe[1].length : name ? name[0].length : 0;
        const after = body.slice(used);
        const tail = pipe ? /^(\S+)/.exec(after) : null;
        return (
          span("prompt", line.slice(0, 2)) +
          prefix +
          (tail
            ? span("cmd", tail[1]) + tokenize(after.slice(tail[1].length), SHELL)
            : tokenize(after, SHELL))
        );
      }
      if (command) {
        command = line.endsWith("\\");
        return tokenize(line, SHELL);
      }
      return line
        ? `<span class="tk-out">${/^\s*["{}[\]]/.test(line) ? tokenize(line, OUTPUT) : escapeHtml(line)}</span>`
        : line;
    })
    .join("\n");
}

export function createTerminalDemo({ onOpen, onClose } = {}) {
  const dialog = document.querySelector("#terminal-demo");
  const screen = dialog.querySelector(".demo-output");
  const range = dialog.querySelector(".demo-progress");
  const timeLabel = dialog.querySelector(".demo-time");
  const pauseButton = dialog.querySelector('[data-demo="pause"]');
  const mode = dialog.querySelector(".demo-mode");
  const chapters = dialog.querySelector(".demo-chapters");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let time = 0;
  let paused = reduced;
  let raf = 0;
  let last = 0;
  let previousFocus;
  let lastText = null;
  let lastChapter = -1;
  let origin = null;
  let closing = false;
  range.max = DURATION;
  CHAPTERS.forEach((chapter, index) => {
    const button = document.createElement("button");
    button.textContent = chapter.title;
    button.addEventListener("click", () => {
      const first = TIMELINE.find((step) => step.chapter === index);
      time = paused ? first.end - 0.001 : first.start;
      stop();
      paint();
      start();
    });
    chapters.append(button);
  });
  function setText(element, value) {
    if (element.textContent !== value) element.textContent = value;
  }
  function paint() {
    const frame = demoFrame(time);
    if (lastText !== frame.text) {
      screen.innerHTML =
        highlight(frame.text, frame.mode) +
        (frame.done ? "" : '<span class="demo-cursor" aria-hidden="true"></span>');
      lastText = frame.text;
      screen.scrollTop = screen.scrollHeight;
    }
    setText(mode, frame.mode);
    if (lastChapter !== frame.chapter) {
      [...chapters.children].forEach((button, index) => {
        button.setAttribute("aria-pressed", String(index === frame.chapter));
      });
      lastChapter = frame.chapter;
    }
    const progress = Math.round(time * 10) / 10;
    if (Number(range.value) !== progress) range.value = progress;
    setText(timeLabel, `${Math.floor(time)}s / ${Math.ceil(DURATION)}s`);
    const state = time >= DURATION ? "replay" : paused ? "play" : "pause";
    if (pauseButton.getAttribute("data-state") !== state) {
      pauseButton.setAttribute("data-state", state);
      pauseButton.setAttribute("aria-label", state[0].toUpperCase() + state.slice(1));
    }
  }
  function stop() {
    cancelAnimationFrame(raf);
    raf = 0;
    last = 0;
  }
  function tick(now) {
    raf = 0;
    if (!dialog.open || paused || document.hidden) return;
    time = Math.min(DURATION, time + (last ? Math.min(0.1, (now - last) / 1000) : 0));
    last = now;
    paint();
    if (time < DURATION) raf = requestAnimationFrame(tick);
  }
  function start() {
    if (dialog.open && !paused && !document.hidden && !raf && time < DURATION)
      raf = requestAnimationFrame(tick);
  }
  // The small hero terminal appears to grow into the player and shrink back.
  function frames() {
    const to = dialog.getBoundingClientRect();
    const from = origin;
    const x = from.left - to.left + (from.width - to.width) / 2;
    const y = from.top - to.top + (from.height - to.height) / 2;
    return [
      {
        transform: `translate(${x}px, ${y}px) scale(${from.width / to.width}, ${from.height / to.height})`,
        opacity: 0.4,
      },
      { transform: "none", opacity: 1 },
    ];
  }
  function shut() {
    if (!dialog.open || closing) return;
    const animation =
      origin && !reduced && dialog.animate
        ? dialog.animate(frames().reverse(), { duration: 240, easing: "ease-in", fill: "forwards" })
        : null;
    closing = !!animation;
    if (animation)
      animation.finished
        .catch(() => {
          // A cancelled shrink is not an error: the dialog still closes below.
        })
        .then(() => {
          closing = false;
          animation.cancel();
          dialog.close();
        });
    else dialog.close();
  }
  pauseButton.addEventListener("click", () => {
    if (time >= DURATION) {
      time = 0;
      paused = false;
    } else paused = !paused;
    stop();
    paint();
    start();
  });
  dialog.querySelector('[data-demo="restart"]').addEventListener("click", () => {
    time = 0;
    stop();
    paint();
    start();
  });
  dialog.querySelector('[data-demo="close"]').addEventListener("click", shut);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    shut();
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) shut();
  });
  range.addEventListener("input", () => {
    time = Number(range.value);
    stop();
    paint();
    start();
  });
  dialog.addEventListener("close", () => {
    stop();
    onClose?.();
    previousFocus?.focus({ preventScroll: true });
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
    else start();
  });
  return {
    open(from = null) {
      if (dialog.open) return;
      previousFocus = document.activeElement;
      origin = from;
      onOpen?.();
      dialog.showModal();
      paint();
      start();
      if (origin && !reduced && dialog.animate)
        dialog.animate(frames(), { duration: 420, easing: "cubic-bezier(.2,.9,.3,1)" });
    },
  };
}
