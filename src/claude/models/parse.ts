/** Parses Claude rows using adapter-owned launch selectors (PRD §5.3, C-API-23). */
import {
  claudeModelPickerHeader,
  parseModelPicker,
  type ScrollGrammar,
} from "../../core/models/rows.ts";
import { claudeModelSelector } from "./selector.ts";

export function parseClaudeModelPicker(text: string, scroll?: ScrollGrammar) {
  return parseModelPicker(text, claudeModelPickerHeader, "claude", claudeModelSelector, scroll);
}
