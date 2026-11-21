import { readFile } from "node:fs/promises";

type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

type ChatResponse = {
  choices: {
    message: Extract<Message, { role: "assistant" }>;
    finish_reason: string;
  }[];
  usage: { prompt_tokens: number; completion_tokens: number };
};

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) throw new Error("DEEPSEEK_API_KEY is not set");

const tools = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file. The path is relative to the project root.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
];

const chat = async (messages: Message[]): Promise<ChatResponse> => {
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "deepseek-flash",
      thinking: { type: "disabled" },
      messages,
      tools,
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as ChatResponse;
};

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

const first = await chat(messages);
const reply = first.choices[0];
if (!reply) throw new Error("Response had no choices");
console.log("1st finish_reason:", reply.finish_reason);
console.dir(reply.message.tool_calls, { depth: null });
messages.push(reply.message);

for (const call of reply.message.tool_calls ?? []) {
  const result = await runReadFile(call.function.arguments);
  messages.push({ role: "tool", tool_call_id: call.id, content: result });
}

const second = await chat(messages);
console.log("2nd finish_reason:", second.choices[0]?.finish_reason);
console.log(second.choices[0]?.message.content);
console.log("usage:", first.usage, second.usage);
