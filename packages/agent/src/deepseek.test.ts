import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vite-plus/test";
import { createDeepSeekLLM } from "./deepseek.ts";
import type { Message, ToolDefinition } from "./llm.ts";

// Real DeepSeek responses, saved once by scripts/record-deepseek.ts.
const fixturePath = new URL("./fixtures/deepseek-read-file.json", import.meta.url);
const recorded = JSON.parse(await readFile(fixturePath, "utf8")) as unknown[];

const replayFetch = (responses: unknown[]) => {
  const requestBodies: unknown[] = [];
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    requestBodies.push(JSON.parse(init?.body as string));
    const body = responses[requestBodies.length - 1];
    if (body === undefined) throw new Error("No recorded response left to replay");
    return Response.json(body);
  };
  return { fetch, requestBodies };
};

const replayLLM = (responses: unknown[]) => {
  const { fetch, requestBodies } = replayFetch(responses);
  const llm = createDeepSeekLLM({ apiKey: "test-key", model: "deepseek-flash", fetch });
  return { llm, requestBodies };
};

const readFileDefinition: ToolDefinition = {
  name: "read_file",
  description: "Read a file.",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};

const question: Message[] = [{ role: "user", content: "What is this project called?" }];

describe("createDeepSeekLLM with recorded responses", () => {
  it("translates a real tool-call response into our Completion", async () => {
    const { llm } = replayLLM([recorded[0]]);

    const completion = await llm.complete(question, [readFileDefinition]);

    expect(completion.stopReason).toBe("tool_calls");
    expect(completion.message.toolCalls).toHaveLength(1);
    expect(completion.message.toolCalls[0]?.name).toBe("read_file");
    expect(JSON.parse(completion.message.toolCalls[0]?.arguments ?? "")).toHaveProperty("path");
    expect(completion.usage.inputTokens).toBeGreaterThan(0);
  });

  it("translates a real final answer into our Completion", async () => {
    const { llm } = replayLLM([recorded[1]]);

    const completion = await llm.complete(question, [readFileDefinition]);

    expect(completion.stopReason).toBe("stop");
    expect(completion.message.toolCalls).toEqual([]);
    expect(completion.message.content).toMatch(/burrow/i);
  });

  it("sends tool calls and tool results in DeepSeek's format", async () => {
    const { llm, requestBodies } = replayLLM([recorded[1]]);
    const conversation: Message[] = [
      ...question,
      {
        role: "assistant",
        content: null,
        toolCalls: [{ id: "call_1", name: "read_file", arguments: '{"path":"package.json"}' }],
      },
      { role: "tool", toolCallId: "call_1", content: '{ "name": "burrow" }' },
    ];

    await llm.complete(conversation, [readFileDefinition]);

    expect(requestBodies[0]).toMatchObject({
      model: "deepseek-flash",
      thinking: { type: "disabled" },
      messages: [
        { role: "user", content: "What is this project called?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "read_file", arguments: '{"path":"package.json"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: '{ "name": "burrow" }' },
      ],
    });
  });
});
