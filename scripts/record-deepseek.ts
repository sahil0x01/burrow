import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createLocalSandbox, readFileTool, runAgent } from "@burrow/agent";
import { createDeepSeekLLM, deepSeekFlashPricing } from "@burrow/agent/deepseek";

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) throw new Error("DEEPSEEK_API_KEY is not set");

const responses: unknown[] = [];

const recordingFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  responses.push(await response.clone().json());
  return response;
};

const result = await runAgent({
  llm: createDeepSeekLLM({ apiKey, model: "deepseek-flash", fetch: recordingFetch }),
  tools: [readFileTool],
  context: { sandbox: createLocalSandbox(process.cwd()) },
  systemPrompt: "You are a coding assistant. Read files before answering questions about them.",
  task: "Read package.json and tell me the project's name.",
  maxSteps: 5,
  pricing: deepSeekFlashPricing,
  maxCostUsd: 0.01,
  maxWallTimeMs: 60_000,
});

const path = "packages/agent/src/fixtures/deepseek-read-file.json";
await mkdir(dirname(path), { recursive: true });
await writeFile(path, `${JSON.stringify(responses, null, 2)}\n`);
console.log(`Recorded ${responses.length} responses to ${path}`, result);
