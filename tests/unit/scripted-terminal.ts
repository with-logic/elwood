/** A scriptable screen terminal for the TUI-automation unit tests (PRD §5.3). */

export type ScriptedTerminal = {
  text: string;
  readonly inputs: string[];
  sendInput(data: string | Uint8Array): void;
  snapshot(): { readonly text: string };
  onInput?: (data: string) => void;
};

export function scripted(initialText: string): ScriptedTerminal {
  const terminal: ScriptedTerminal = {
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
