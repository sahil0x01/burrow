import { readFileTool, runAgent } from "@burrow/agent";
import type { AgentEvent } from "@burrow/agent";
import { createDeepSeekLLM, deepSeekFlashPricing } from "@burrow/agent/deepseek";

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) throw new Error("DEEPSEEK_API_KEY is not set");

const preview = (text: string): string => {
  const oneLine = text.replaceAll("\n", " ");
  return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
};

const printEvent = (event: AgentEvent): void => {
  switch (event.type) {
    case "model_call":
      console.log(
        `\n[step ${event.step}] model → ${event.stopReason} ($${event.costUsd.toFixed(5)})`,
      );
      if (event.text) console.log(`  says: ${preview(event.text)}`);
      break;
    case "tool_call":
      console.log(`  → ${event.call.name}(${event.call.arguments})`);
      break;
    case "tool_result":
      console.log(`  ← ${event.result.status}: ${preview(event.result.output)}`);
      break;
    case "done":
      console.log("\nresult:", event.result);
      break;
  }
};

await runAgent({
  llm: createDeepSeekLLM({ apiKey, model: "deepseek-flash" }),
  tools: [readFileTool],
  context: { workdir: process.cwd() },
  systemPrompt: "You are a coding assistant. Read files before answering questions about them.",
  task: "Which Node version does this project pin, and which packages does packages/agent depend on?",
  maxSteps: 10,
  pricing: deepSeekFlashPricing,
  maxCostUsd: 0.01,
  onEvent: printEvent,
});
