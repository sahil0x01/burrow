import { costOf } from "./cost.ts";
import type { Pricing } from "./cost.ts";
import type { LLM, Message, StopReason, ToolCall, Usage } from "./llm.ts";
import { fail } from "./tool.ts";
import type { Tool, ToolContext, ToolResult } from "./tool.ts";

export type AgentResult =
  | { outcome: "done"; answer: string; steps: number; costUsd: number }
  | { outcome: "failed"; reason: string; steps: number; costUsd: number };

export type AgentEvent =
  | {
      type: "model_call";
      step: number;
      stopReason: StopReason;
      text: string | null;
      usage: Usage;
      costUsd: number;
    }
  | { type: "tool_call"; step: number; call: ToolCall }
  | { type: "tool_result"; step: number; toolCallId: string; result: ToolResult }
  | { type: "done"; result: AgentResult };

export type AgentOptions = {
  llm: LLM;
  tools: readonly Tool[];
  context: ToolContext;
  systemPrompt: string;
  task: string;
  maxSteps: number;
  pricing: Pricing;
  maxCostUsd: number;
  onEvent?: (event: AgentEvent) => void;
};

export const runAgent = async (options: AgentOptions): Promise<AgentResult> => {
  const result = await runLoop(options);
  options.onEvent?.({ type: "done", result });
  return result;
};

const runLoop = async (options: AgentOptions): Promise<AgentResult> => {
  const { llm, tools, context, systemPrompt, task, maxSteps, pricing, maxCostUsd } = options;
  const emit = options.onEvent ?? (() => {});

  const toolsByName = new Map(tools.map((tool) => [tool.definition.name, tool]));
  const definitions = tools.map((tool) => tool.definition);

  const messages: Message[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: task },
  ];

  let costUsd = 0;

  for (let step = 1; step <= maxSteps; step++) {
    const completion = await llm.complete(messages, definitions);
    messages.push(completion.message);
    const callCostUsd = costOf(completion.usage, pricing);
    costUsd += callCostUsd;
    emit({
      type: "model_call",
      step,
      stopReason: completion.stopReason,
      text: completion.message.content,
      usage: completion.usage,
      costUsd: callCostUsd,
    });

    switch (completion.stopReason) {
      case "stop":
        return { outcome: "done", answer: completion.message.content ?? "", steps: step, costUsd };

      case "length":
        return {
          outcome: "failed",
          reason: "The reply was cut off (too long)",
          steps: step,
          costUsd,
        };

      case "content_filter":
        return {
          outcome: "failed",
          reason: "The reply was blocked by a content filter",
          steps: step,
          costUsd,
        };

      case "tool_calls":
        if (costUsd >= maxCostUsd) {
          const reason = `Reached the cost limit ($${maxCostUsd})`;
          return { outcome: "failed", reason, steps: step, costUsd };
        }
        for (const call of completion.message.toolCalls) {
          emit({ type: "tool_call", step, call });
          const tool = toolsByName.get(call.name);
          const result = tool
            ? await tool.execute(call.arguments, context)
            : fail(`Unknown tool: ${call.name}`);
          emit({ type: "tool_result", step, toolCallId: call.id, result });
          messages.push({ role: "tool", toolCallId: call.id, content: result.output });
        }
        break;
    }
  }

  const reason = `Reached the step limit (${maxSteps})`;
  return { outcome: "failed", reason, steps: maxSteps, costUsd };
};
