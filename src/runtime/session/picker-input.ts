/** Raw terminal intervention revokes a picker operation's private authority (C-API-55). */
import type { EmptyComposerObserver } from "../../core/input/clear-ack.ts";
import { ComposerCleanup } from "../../core/input/composer-cleanup.ts";
import { pickerIntervention } from "../../core/models/intervention.ts";
import type { ElwoodTerminal } from "../../terminal/headless.ts";

type AutomatedWork = () => Promise<void>;
const automationScopes = new WeakMap<
  ElwoodTerminal["xterm"],
  (work: AutomatedWork) => Promise<void>
>();

/** Preserve the same ownership scope for startup writers that retain their own input policy. */
export function withAutomatedInput(terminal: ElwoodTerminal, work: AutomatedWork): Promise<void> {
  return automationScopes.get(terminal.xterm)?.(work) ?? work();
}

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
    // onData also carries parser-generated protocol replies; only input invocations
    // represent caller keys. Native startup queries must not revoke draft ownership.
    const input = inner.xterm.input.bind(inner.xterm);
    inner.xterm.input = (data, wasUserInput) => {
      if (!automating) revoke();
      input(data, wasUserInput);
    };
    const automate = (work: AutomatedWork) => {
      const prior = automating;
      automating = true;
      try {
        return work();
      } finally {
        automating = prior;
      }
    };
    automationScopes.set(inner.xterm, automate);
    const send = (input: string | Uint8Array) => automate(() => inner.sendInput(input));
    this.automated = view(inner, send);
    this.caller = view(inner, (input) => {
      revoke();
      return send(input);
    });
  }

  composerCleanup(
    blocked: () => boolean,
    closing: AbortSignal,
    observeEmpty: EmptyComposerObserver,
  ): ComposerCleanup["run"] {
    const cleanup = new ComposerCleanup(
      this.automated,
      blocked,
      closing,
      () => this.signal(),
      observeEmpty,
    );
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
