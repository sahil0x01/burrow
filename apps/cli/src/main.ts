import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import {
  CODING_AGENT_SYSTEM_PROMPT,
  createRunCommandTool,
  readFileTool,
  runAgent,
  writeFileTool,
} from "@burrow/agent";
import { createDeepSeekLLM, deepSeekFlashPricing } from "@burrow/agent/deepseek";
import { printEvent } from "./print-event.ts";

const usage = 'Usage: node --env-file=.env apps/cli/src/main.ts --dir <repo folder> "<task>"';

const askYesNo = async (question: string): Promise<boolean> => {
  const prompt = createInterface({ input: stdin, output: stdout });
  const answer = await prompt.question(question);
  prompt.close();
  return answer.trim().toLowerCase() === "y";
};

const { values, positionals } = parseArgs({
  options: { dir: { type: "string" } },
  allowPositionals: true,
});

const task = positionals.join(" ").trim();
if (!values.dir || !task) {
  console.error(usage);
  process.exit(2);
}

const workdir = resolve(values.dir);
const folder = await stat(workdir).catch(() => undefined);
if (!folder?.isDirectory()) {
  console.error(`Not a folder: ${workdir}`);
  process.exit(2);
}

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
  console.error("DEEPSEEK_API_KEY is not set. Run with --env-file=.env");
  process.exit(2);
}

console.log(`Working in ${workdir}`);
console.log(`Task: ${task}`);

const result = await runAgent({
  llm: createDeepSeekLLM({ apiKey, model: "deepseek-flash" }),
  tools: [
    readFileTool,
    writeFileTool,
    createRunCommandTool({ approve: (command) => askYesNo(`\n  run \`${command}\`? [y/N] `) }),
  ],
  context: { workdir },
  systemPrompt: CODING_AGENT_SYSTEM_PROMPT,
  task,
  maxSteps: 30,
  pricing: deepSeekFlashPricing,
  maxCostUsd: 0.05,
  onEvent: printEvent,
});

process.exitCode = result.outcome === "done" ? 0 : 1;
