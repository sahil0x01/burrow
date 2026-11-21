import { readFile } from "node:fs/promises";
import type { Message, ToolDefinition } from "@burrow/agent";
import { createDeepSeekLLM } from "@burrow/agent/deepseek";

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) throw new Error("DEEPSEEK_API_KEY is not set");

const llm = createDeepSeekLLM({ apiKey, model: "deepseek-flash" });

const tools: ToolDefinition[] = [
  {
    name: "read_file",
    description: "Read a UTF-8 text file. The path is relative to the project root.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
];

const runReadFile = async (rawArgs: string): Promise<string> => {
  try {
    const { path } = JSON.parse(rawArgs) as { path: string };
    if (path.startsWith("/") || path.includes(".."))
      return "Error: path must stay inside the project.";
    return await readFile(path, "utf8");
  } catch (error) {
    return `Error: ${String(error)}`;
  }
};

const messages: Message[] = [
  {
    role: "system",
    content: "You are a coding assistant. Read files before answering questions about them.",
  },
  {
    role: "user",
    content: "What is this project called, and which Node version does it pin?",
  },
];

const first = await llm.complete(messages, tools);
console.log("1st stop reason:", first.stopReason);
console.dir(first.message.toolCalls, { depth: null });
messages.push(first.message);

for (const call of first.message.toolCalls) {
  messages.push({
    role: "tool",
    toolCallId: call.id,
    content: await runReadFile(call.arguments),
  });
}

const second = await llm.complete(messages, tools);
console.log("2nd stop reason:", second.stopReason);
console.log(second.message.content);
console.log("usage:", first.usage, second.usage);
