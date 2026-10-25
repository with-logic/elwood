/** A scriptable screen terminal for the TUI-automation unit tests (PRD §5.3). */

import { synchronousRender } from "../helpers/synchronous-render.ts";

export type ScriptedTerminal = {
  text: string;
  readonly inputs: string[];
  sendInput(data: string | Uint8Array): void;
  snapshot(): { readonly text: string };
  onInput?: (data: string) => void;
  settled(): Promise<void>;
  readonly renderFailed: boolean;
};

export function scripted(initialText: string): ScriptedTerminal {
  const terminal: ScriptedTerminal = {
    ...synchronousRender,
    text: initialText,
    inputs: [],
    snapshot: () => ({ text: terminal.text }),
    sendInput: (data) => {
      const input = String(data);
      terminal.inputs.push(input);
      terminal.onInput?.(input);
    },
  };
  return terminal;
}
