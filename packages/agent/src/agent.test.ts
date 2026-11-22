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
    maxWallTimeMs: 60_000,
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
      content: "Unknown tool: delete_everything. Available tools: echo",
    });
  });

  it("tells the model when it says it will call tools but sends none", async () => {
    const { llm, requests } = scriptedLLM([toolReply(), stopReply("Done.")]);

    expect(await run(llm)).toMatchObject({ outcome: "done", steps: 2 });
    expect(requests[1]?.at(-1)).toEqual({
      role: "user",
      content: "Your reply had no tool calls. Call a tool, or reply with your final answer.",
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

  it("stops at the time limit before running more tools", async () => {
    const call = { id: "call_1", name: "echo", arguments: '{"text":"again"}' };
    const { llm } = scriptedLLM(Array.from({ length: 10 }, () => toolReply(call)));
    // A fake clock: every time the agent looks at it, 10 seconds have passed.
    // Start reads 10 s; checks after steps 1, 2, 3 see 10 s, 20 s, 30 s elapsed.
    let time = 0;
    const now = () => (time += 10_000);
    const events: AgentEvent[] = [];

    const result = await run(llm, { maxWallTimeMs: 25_000, now, onEvent: (e) => events.push(e) });

    expect(result).toEqual({
      outcome: "failed",
      reason: "Reached the time limit (25 s)",
      steps: 3,
      costUsd: 3,
    });
    expect(events.filter((event) => event.type === "tool_call")).toHaveLength(2);
  });

  it("does not run the 3rd identical call in a row and tells the model why", async () => {
    const call = { id: "call_1", name: "echo", arguments: '{"text":"again"}' };
    const { llm, requests } = scriptedLLM([
      toolReply(call),
      toolReply(call),
      toolReply(call),
      stopReply("Ok, trying something else."),
    ]);

    await run(llm);

    expect(requests[2]?.at(-1)).toMatchObject({ content: "echo: again" });
    expect(requests[3]?.at(-1)).toMatchObject({
      content: expect.stringContaining("3 times in a row, so it was not run again"),
    });
  });

  it("stops the run on the 5th identical call in a row", async () => {
    const call = { id: "call_1", name: "echo", arguments: '{"text":"again"}' };
    const { llm } = scriptedLLM(Array.from({ length: 10 }, () => toolReply(call)));

    expect(await run(llm)).toEqual({
      outcome: "failed",
      reason: "Stuck repeating the same echo call",
      steps: 5,
      costUsd: 5,
    });
  });

  it("starts counting again after a different call", async () => {
    const same = { id: "call_1", name: "echo", arguments: '{"text":"again"}' };
    const other = { id: "call_2", name: "echo", arguments: '{"text":"something else"}' };
    const { llm, requests } = scriptedLLM([
      toolReply(same),
      toolReply(same),
      toolReply(other),
      toolReply(same),
      stopReply("Done."),
    ]);

    await run(llm);

    expect(requests[4]?.at(-1)).toMatchObject({ content: "echo: again" });
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

  it("stops before the next step when cancelled", async () => {
    const stop = new AbortController();
    const { llm, requests } = scriptedLLM([
      toolReply({ id: "1", name: "echo", arguments: JSON.stringify({ text: "a" }) }),
      stopReply("never reached"),
    ]);

    const result = await run(llm, {
      signal: stop.signal,
      // Cancel while the first step's tool call is being handled.
      onEvent: (event) => {
        if (event.type === "tool_result") stop.abort();
      },
    });

    expect(result).toEqual({ outcome: "cancelled", reason: "Cancelled", steps: 1, costUsd: 1 });
    expect(requests).toHaveLength(1);
  });
});
