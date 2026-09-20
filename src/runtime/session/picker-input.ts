/** Raw terminal intervention revokes a picker operation's private authority (C-API-55). */
import { ComposerCleanup } from "../../core/input/composer-cleanup.ts";
import { pickerIntervention } from "../../core/models/intervention.ts";
import type { ElwoodTerminal } from "../../terminal/headless.ts";

export class PickerInputOwnership {
  readonly caller: ElwoodTerminal;
  readonly automated: ElwoodTerminal;
  private current = new AbortController();

  constructor(inner: ElwoodTerminal) {
    let automating = false;
    const revoke = () => {
      this.current.abort(pickerIntervention());
      this.current = new AbortController();
    };
    inner.xterm.onData(() => {
      if (!automating) revoke();
    });
    const send = (input: string | Uint8Array) => {
      automating = true;
      try {
        return inner.sendInput(input);
      } finally {
        automating = false;
      }
    };
    this.automated = view(inner, send);
    this.caller = view(inner, (input) => {
      revoke();
      return send(input);
    });
  }

  composerCleanup(blocked: () => boolean, closing: AbortSignal): ComposerCleanup["run"] {
    const cleanup = new ComposerCleanup(this.automated, blocked, closing, () => this.signal());
    return (work, signal) => cleanup.run(work, signal);
  }

  signal(): AbortSignal {
    return this.current.signal;
  }
}

function view(inner: ElwoodTerminal, sendInput: ElwoodTerminal["sendInput"]): ElwoodTerminal {
  return {
    get xterm() {
      return inner.xterm;
    },
    get size() {
      return inner.size;
    },
    get title() {
      return inner.title;
    },
    get renderFailed() {
      return inner.renderFailed;
    },
    writeOutput: (...args) => inner.writeOutput(...args),
    sendInput,
    resize: (size) => inner.resize(size),
    snapshot: () => inner.snapshot(),
    settled: () => inner.settled(),
    dispose: () => inner.dispose(),
  };
}
