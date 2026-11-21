import OpenAI from "openai";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type { LLM, Message, StopReason, ToolDefinition } from "./llm.ts";
import type { Pricing } from "./cost.ts";

export type DeepSeekConfig = { apiKey: string; model: string };

// deepseek-flash, peak-hour prices in USD per million tokens (checked 2026-11-21).
// Off-peak is half price, so using peak prices makes the budget guard err on the safe side.
export const deepSeekFlashPricing: Pricing = {
  inputPerMillion: 0.3,
  cachedInputPerMillion: 0.006,
  outputPerMillion: 1.2,
};

const toWireMessage = (message: Message): ChatCompletionMessageParam => {
  switch (message.role) {
    case "system":
    case "user":
      return { role: message.role, content: message.content };

    case "assistant": {
      if (message.toolCalls.length === 0) return { role: "assistant", content: message.content };
      return {
        role: "assistant",
        content: message.content,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        })),
      };
    }
    case "tool":
      return {
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.content,
      };
  }
};

const toWireTool = (tool: ToolDefinition): ChatCompletionTool => ({
  type: "function",
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  },
});

const toStopReason = (reason: string): StopReason => {
  switch (reason) {
    case "tool_calls":
    case "stop":
    case "length":
    case "content_filter":
      return reason;
    default:
      throw new Error(`Unexpected finish_reason from DeepSeek: ${reason}`);
  }
};

export const createDeepSeekLLM = ({ apiKey, model }: DeepSeekConfig): LLM => {
  const client = new OpenAI({ apiKey, baseURL: "https://api.deepseek.com" });

  return {
    async complete(messages, tools) {
      const params: ChatCompletionCreateParamsNonStreaming & {
        thinking: { type: "disabled" };
      } = {
        model,
        messages: messages.map(toWireMessage),
        tools: tools.map(toWireTool),
        thinking: { type: "disabled" },
      };
      const response = await client.chat.completions.create(params);

      const choice = response.choices[0];
      if (!choice) throw new Error("DeepSeek returned no choices");
      if (!response.usage) throw new Error("DeepSeek returned no usage");

      const toolCalls = (choice.message.tool_calls ?? []).map((call) => {
        if (call.type !== "function") throw new Error(`Unexpected tool call type: ${call.type}`);
        return {
          id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        };
      });

      return {
        message: {
          role: "assistant",
          content: choice.message.content,
          toolCalls,
        },
        stopReason: toStopReason(choice.finish_reason),
        usage: {
          inputTokens: response.usage.prompt_tokens,
          cachedInputTokens: response.usage.prompt_tokens_details?.cached_tokens ?? 0,
          outputTokens: response.usage.completion_tokens,
        },
      };
    },
  };
};
