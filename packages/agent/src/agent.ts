import { costOf } from "./cost.ts";
import type { Pricing } from "./cost.ts";
import type { LLM, Message } from "./llm.ts";
import { fail } from "./tool.ts";
import type { Tool, ToolContext } from "./tool.ts";

export type AgentOptions = {
  llm: LLM;
  tools: readonly Tool[];
  context: ToolContext;
  systemPrompt: string;
  task: string;
  maxSteps: number;
  pricing: Pricing;
  maxCostUsd: number;
};

export type AgentResult =
  | { outcome: "done"; answer: string; steps: number; costUsd: number }
  | { outcome: "failed"; reason: string; steps: number; costUsd: number };

export const runAgent = async (options: AgentOptions): Promise<AgentResult> => {
  const { llm, tools, context, systemPrompt, task, maxSteps, pricing, maxCostUsd } = options;

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
    costUsd += costOf(completion.usage, pricing);

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
          const tool = toolsByName.get(call.name);
          const result = tool
            ? await tool.execute(call.arguments, context)
            : fail(`Unknown tool: ${call.name}`);
          messages.push({ role: "tool", toolCallId: call.id, content: result.output });
        }
        break;
    }
  }

  const reason = `Reached the step limit (${maxSteps})`;
  return { outcome: "failed", reason, steps: maxSteps, costUsd };
};
