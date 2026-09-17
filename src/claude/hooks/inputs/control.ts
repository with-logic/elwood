/** Native Claude task and plan input shapes, implementing PRD §6.4. */

export type IdInput = { readonly id: string };
export type TaskGetInput = { readonly taskId: string };
export type TaskOutputInput = {
  readonly task_id: string;
  readonly block: boolean;
  readonly timeout: number;
};
export type TaskStopInput = {
  readonly task_id?: string;
  readonly shell_id?: string;
};
export type ExitPlanModeInput = {
  readonly allowedPrompts?: readonly { readonly tool: "Bash"; readonly prompt: string }[];
  readonly plan?: string;
  readonly planFilePath?: string;
};
