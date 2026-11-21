import * as z from "zod";
import { describe, expect, it } from "vite-plus/test";
import { runAgent } from "./agent.ts";
import type { AgentEvent, AgentOptions } from "./agent.ts";
import type { Completion, LLM, Message, ToolCall } from "./llm.ts";
import { createLocalSandbox } from "./local-sandbox.ts";
import { defineTool, ok } from "./tool.ts";

// Every scripted reply "uses" one million input tokens. With the pricing below,
// that makes every model call cost exactly $1, so costs are easy to check by hand.
const usage = { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 };
const pricing = { inputPerMillion: 1, cachedInputPerMillion: 0, outputPerMillion: 0 };

const stopReply = (text: string): Completion => ({
  message: { role: "assistant", content: text, toolCalls: [] },
  stopReason: "stop",
  usage,
});

const toolReply = (...toolCalls: ToolCall[]): Completion => ({
  message: { role: "assistant", content: null, toolCalls },
  stopReason: "tool_calls",
  usage,
});

const scriptedLLM = (replies: Completion[]) => {
  const requests: Message[][] = [];
  const llm: LLM = {
    async complete(messages) {
      requests.push([...messages]);
      const reply = replies[requests.length - 1];
      if (!reply) throw new Error(`No scripted reply for call ${requests.length}`);
      return reply;
    },
  };
  return { llm, requests };
};

const echoTool = defineTool({
  name: "echo",
  description: "Echo the text back.",
  schema: z.object({ text: z.string() }),
  async run({ text }) {
    return ok(`echo: ${text}`);
  },
});

const run = (llm: LLM, overrides: Partial<AgentOptions> = {}) =>
  runAgent({
    llm,
    tools: [echoTool],
    context: { sandbox: createLocalSandbox("/unused") },
    systemPrompt: "You are a test agent.",
    task: "Do the thing.",
    maxSteps: 10,
    pricing,
    maxCostUsd: 100,
    ...overrides,
  });

describe("runAgent", () => {
  it("finishes when the model stops", async () => {
    const { llm } = scriptedLLM([stopReply("All done.")]);

    expect(await run(llm)).toEqual({ outcome: "done", answer: "All done.", steps: 1, costUsd: 1 });
  });

  it("runs a requested tool and sends the result back to the model", async () => {
    const { llm, requests } = scriptedLLM([
      toolReply({ id: "call_1", name: "echo", arguments: '{"text":"hi"}' }),
      stopReply("The tool said hi."),
    ]);

    const result = await run(llm);

    expect(result).toMatchObject({ outcome: "done", steps: 2, costUsd: 2 });
    expect(requests[1]?.at(-1)).toEqual({
      role: "tool",
      toolCallId: "call_1",
      content: "echo: hi",
    });
  });

  it("tells the model when it asks for a tool that does not exist", async () => {
    const { llm, requests } = scriptedLLM([
      toolReply({ id: "call_1", name: "delete_everything", arguments: "{}" }),
      stopReply("Sorry."),
    ]);

    await run(llm);

    expect(requests[1]?.at(-1)).toEqual({
      role: "tool",
      toolCallId: "call_1",
      content: "Unknown tool: delete_everything",
    });
  });

  it("stops at the step limit", async () => {
    const call = { id: "call_1", name: "echo", arguments: '{"text":"again"}' };
    const { llm, requests } = scriptedLLM(Array.from({ length: 10 }, () => toolReply(call)));

    const result = await run(llm, { maxSteps: 3 });

    expect(result).toEqual({
      outcome: "failed",
      reason: "Reached the step limit (3)",
      steps: 3,
      costUsd: 3,
    });
    expect(requests).toHaveLength(3);
  });

  it("stops at the cost limit before running more tools", async () => {
    const call = { id: "call_1", name: "echo", arguments: '{"text":"again"}' };
    const { llm } = scriptedLLM(Array.from({ length: 10 }, () => toolReply(call)));
    const events: AgentEvent[] = [];

    const result = await run(llm, { maxCostUsd: 2, onEvent: (event) => events.push(event) });

    expect(result).toEqual({
      outcome: "failed",
      reason: "Reached the cost limit ($2)",
      steps: 2,
      costUsd: 2,
    });
    expect(events.filter((event) => event.type === "tool_call")).toHaveLength(1);
  });

  it("emits events in order", async () => {
    const { llm } = scriptedLLM([
      toolReply({ id: "call_1", name: "echo", arguments: '{"text":"hi"}' }),
      stopReply("Done."),
    ]);
    const events: AgentEvent[] = [];

    await run(llm, { onEvent: (event) => events.push(event) });

    expect(events.map((event) => event.type)).toEqual([
      "model_call",
      "tool_call",
      "tool_result",
      "model_call",
      "done",
    ]);
  });
});
