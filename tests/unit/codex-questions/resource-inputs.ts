/** Native catalog fixtures for private resource-limit regression proofs (PRD §4). */
export function native(id: string, count = 1, title = "Question") {
  return {
    payload: {
      type: "AgentMessage",
      id,
      delivery: "async",
      questions: Array.from({ length: count }, () => ({ title })),
    },
  };
}
export const oversizedInputKinds = [
  "message-count",
  "call-count",
  "call-bytes",
  "message-bytes",
  "identity-bytes",
] as const;
export function oversizedQuestionInput(kind: (typeof oversizedInputKinds)[number]) {
  const mib = 1024 * 1024;
  const call = {
    type: "function_call",
    name: "request_user_input_async",
    call_id: "oversized",
    arguments: "",
  };
  switch (kind) {
    case "message-count":
      return native("oversized", 257);
    case "call-count":
      return {
        payload: {
          ...call,
          arguments: JSON.stringify({
            questions: Array.from({ length: 257 }, () => ({ title: "Q" })),
          }),
        },
      };
    case "call-bytes":
      return { payload: { ...call, arguments: "é".repeat(mib / 2 + 1) } };
    case "message-bytes":
      return native("oversized", 1, "é".repeat(mib / 2));
    case "identity-bytes":
      return native("é".repeat(mib / 2), 1);
  }
}
