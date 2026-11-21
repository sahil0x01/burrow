import type { AgentEvent } from "@burrow/agent";

const preview = (text: string, maxLength = 100): string => {
  const oneLine = text.replaceAll("\n", " ");
  return oneLine.length > maxLength ? `${oneLine.slice(0, maxLength)}…` : oneLine;
};

export const printEvent = (event: AgentEvent): void => {
  switch (event.type) {
    case "model_call":
      console.log(
        `\n[step ${event.step}] model → ${event.stopReason} ($${event.costUsd.toFixed(5)})`,
      );
      if (event.text) console.log(`  says: ${preview(event.text, 200)}`);
      break;
    case "tool_call":
      console.log(`  → ${event.call.name}(${preview(event.call.arguments)})`);
      break;
    case "tool_result":
      console.log(`  ← ${event.result.status}: ${preview(event.result.output)}`);
      break;
    case "done": {
      const { result } = event;
      const summary = result.outcome === "done" ? result.answer : result.reason;
      console.log(`\n${result.outcome.toUpperCase()} after ${result.steps} steps`);
      console.log(`cost: $${result.costUsd.toFixed(5)}`);
      console.log(summary);
      break;
    }
  }
};
