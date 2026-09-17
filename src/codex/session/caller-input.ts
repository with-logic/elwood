/**
 * Reports every caller-side terminal write so startup-only recognition can end
 * before caller content can reach the screen. Implements PRD §5.7 / C-API-14.
 */
import type { ElwoodTerminal } from "../../terminal/headless.ts";

export type CallerInput = {
  /** The session's view of the terminal: every write through it is caller input. */
  readonly terminal: ElwoodTerminal;
  /** Startup automation's writer: the only input that does not end startup. */
  readonly automation: (input: string) => Promise<void>;
};

/**
 * Two hooks, because there are two caller paths: `sendInput` (strings and raw bytes,
 * which skip xterm's data event) and the public `xterm.input()`, which skips
 * `sendInput`. xterm fires its data event synchronously, so a flag scopes automation.
 */
export function reportCallerInput(
  inner: ElwoodTerminal,
  onInput: () => void,
  priorInput = false,
): CallerInput {
  // A resumed session replays a transcript that already holds caller and model text,
  // possibly without any conversation marker left in the frames this process sees.
  if (priorInput) onInput();
  let automating = false;
  inner.xterm.onData(() => {
    if (!automating) onInput();
  });
  const terminal: ElwoodTerminal = {
    get xterm() {
      return inner.xterm;
    },
    get size() {
      return inner.size;
    },
    get title() {
      return inner.title;
    },
    writeOutput: (...args) => inner.writeOutput(...args),
    sendInput: (input) => {
      onInput();
      return inner.sendInput(input);
    },
    resize: (size) => inner.resize(size),
    snapshot: () => inner.snapshot(),
    settled: () => inner.settled(),
    get renderFailed() {
      return inner.renderFailed;
    },
    dispose: () => inner.dispose(),
  };
  const automation = (input: string) => {
    automating = true;
    try {
      return inner.sendInput(input);
    } finally {
      automating = false;
    }
  };
  return { terminal, automation };
}
