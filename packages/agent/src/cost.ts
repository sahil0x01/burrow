import type { Usage } from "./llm.ts";

export type Pricing = {
  inputPerMillion: number;
  cachedInputPerMillion: number;
  outputPerMillion: number;
};

export const costOf = (usage: Usage, pricing: Pricing): number => {
  const uncachedInputTokens = usage.inputTokens - usage.cachedInputTokens;
  const total =
    uncachedInputTokens * pricing.inputPerMillion +
    usage.cachedInputTokens * pricing.cachedInputPerMillion +
    usage.outputTokens * pricing.outputPerMillion;
  return total / 1_000_000;
};
