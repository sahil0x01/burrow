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
  // Checked between steps, so one model call and its commands (each with its own timeout)
  // can run past it. It stops a run that keeps going, not a single slow command.
  maxWallTimeMs: number;
  onEvent?: (event: AgentEvent) => void;
  // The clock, so tests can control time. Defaults to Date.now.
  now?: () => number;
};

// The same tool call many times in a row means the model is stuck. On the 3rd repeat we
// skip it and tell the model why; on the 5th we stop the run.
const NUDGE_AFTER_REPEATS = 3;
const STOP_AFTER_REPEATS = 5;

export const runAgent = async (options: AgentOptions): Promise<AgentResult> => {
  const result = await runLoop(options);
  options.onEvent?.({ type: "done", result });
  return result;
};

const runLoop = async (options: AgentOptions): Promise<AgentResult> => {
  const { llm, tools, context, systemPrompt, task, maxSteps, pricing, maxCostUsd, maxWallTimeMs } =
    options;
  const emit = options.onEvent ?? (() => {});
  const now = options.now ?? Date.now;
  const started = now();

  const toolsByName = new Map(tools.map((tool) => [tool.definition.name, tool]));
  const definitions = tools.map((tool) => tool.definition);

  const messages: Message[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: task },
  ];

  let costUsd = 0;
  let lastSignature = "";
  let repeats = 0;

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
        if (now() - started >= maxWallTimeMs) {
          const reason = `Reached the time limit (${maxWallTimeMs / 1000} s)`;
          return { outcome: "failed", reason, steps: step, costUsd };
        }
        for (const call of completion.message.toolCalls) {
          // Same tool and same arguments as the call just before it.
          const signature = `${call.name}\n${call.arguments}`;
          repeats = signature === lastSignature ? repeats + 1 : 1;
          lastSignature = signature;
          if (repeats >= STOP_AFTER_REPEATS) {
            const reason = `Stuck repeating the same ${call.name} call`;
            return { outcome: "failed", reason, steps: step, costUsd };
          }

          emit({ type: "tool_call", step, call });
          const tool = toolsByName.get(call.name);
          const result =
            repeats >= NUDGE_AFTER_REPEATS
              ? fail(
                  `You made this exact ${call.name} call ${repeats} times in a row, so it was not run again. Nothing has changed since the last one. Try something different.`,
                )
              : tool
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
