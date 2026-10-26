/**
 * The one gate for every picker key and every frame the window walk reads.
 * Implements PRD §5.3 and C-API-24.
 */

import type { ModelPickerSpec } from "./picker.ts";
import { ownOperation } from "./rows.ts";

/**
 * True only while THIS operation's own COMPLETE picker is the bottom-most region: never its
 * `painting` shell and never a `follow-up` stage. It gates every shared navigation,
 * selection, and cancelling key, each adapter's selecting key, and every frame the window
 * walk reads; a follow-up is answered only by the adapter's `apply`, under that stage's own
 * guard (Claude's cache warning, Codex's reasoning level).
 *
 * Elwood is inside the transaction that wrote `/model`, so these reads carry its authority
 * (`ownOperation`). A header match alone is untrusted: a transcript or the agent's own output
 * can print `Select model`, so navigating or Escaping on it could send keys into a running
 * turn, the real composer, or another prompt (C-API-24). The header gates only the `/model`
 * open wait (`openAndParse`); the cursor-settle wait reads a parsed row, and the close wait
 * (`waitUntilClosed`) reads only the bottom-most region. None of them writes.
 */
export const isOwnCompletePicker =
  (spec: Pick<ModelPickerSpec, "activeDialog">) => (text: string) =>
    spec.activeDialog(text, ownOperation) === "picker";
