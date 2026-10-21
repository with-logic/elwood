/** Shared request definitions for private kernel tests (PRD §4). */
import type { QuestionDefinition } from "../../../src/core/questions/types.ts";
export const definitions: readonly QuestionDefinition[] = [
  {
    prompt: "Which test color?",
    header: "Color",
    options: [
      { label: "Amber", description: "Warm" },
      { label: "Blue", description: "Cool" },
    ],
    selection: "single",
    textMode: "alternative",
    secret: false,
  },
  {
    prompt: "Which test features?",
    header: "Features",
    options: [
      { label: "Logging", description: "Logs" },
      { label: "Metrics", description: "Counts" },
    ],
    selection: "multiple",
    textMode: "none",
    secret: false,
  },
];
