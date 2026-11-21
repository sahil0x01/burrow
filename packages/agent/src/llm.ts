export type ToolCall = { id: string; name: string; arguments: string };

export type AssistantMessage = {
  role: "assistant";
  content: string | null;
  toolCalls: ToolCall[];
};

export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | AssistantMessage
  | { role: "tool"; toolCallId: string; content: string };

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type StopReason = "tool_calls" | "stop" | "length" | "content_filter";

export type Usage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

export type Completion = {
  message: AssistantMessage;
  stopReason: StopReason;
  usage: Usage;
};

export interface LLM {
  complete(messages: readonly Message[], tools: readonly ToolDefinition[]): Promise<Completion>;
}
