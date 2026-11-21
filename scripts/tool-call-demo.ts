import { readFileTool, runAgent } from "@burrow/agent";
import { createDeepSeekLLM } from "@burrow/agent/deepseek";

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) throw new Error("DEEPSEEK_API_KEY is not set");

const result = await runAgent({
  llm: createDeepSeekLLM({ apiKey, model: "deepseek-flash" }),
  tools: [readFileTool],
  context: { workdir: process.cwd() },
  systemPrompt: "You are a coding assistant. Read files before answering questions about them.",
  task: "Which Node version does this project pin, and which packages does packages/agent depend on?",
  maxSteps: 10,
});

console.log(result);
