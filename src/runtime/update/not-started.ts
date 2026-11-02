/** An updater refused before execution is no completed attempt (PRD §9.2, C-LIFE-09). */
export type UpdateNotStarted = { readonly started: false };
// biome-ignore lint/suspicious/noConfusingVoidType: Existing updater callbacks return void; only refusals carry a result.
export type UpdateResult = void | UpdateNotStarted;
export type UpdateOperation = () => Promise<UpdateResult>;
