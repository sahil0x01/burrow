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
};

export type AgentResult =
  | { outcome: "done"; answer: string; steps: number }
  | { outcome: "failed"; reason: string; steps: number };

export const runAgent = async (options: AgentOptions): Promise<AgentResult> => {
  const { llm, tools, context, systemPrompt, task, maxSteps } = options;

  const toolsByName = new Map(tools.map((tool) => [tool.definition.name, tool]));
  const definitions = tools.map((tool) => tool.definition);

  const messages: Message[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: task },
  ];

  for (let step = 1; step <= maxSteps; step++) {
    const completion = await llm.complete(messages, definitions);
    messages.push(completion.message);

    switch (completion.stopReason) {
      case "stop":
        return { outcome: "done", answer: completion.message.content ?? "", steps: step };

      case "length":
        return { outcome: "failed", reason: "The reply was cut off (too long)", steps: step };

      case "content_filter":
        return {
          outcome: "failed",
          reason: "The reply was blocked by a content filter",
          steps: step,
        };

      case "tool_calls":
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

  return { outcome: "failed", reason: `Reached the step limit (${maxSteps})`, steps: maxSteps };
};
