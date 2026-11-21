import { describe, expect, it } from "vite-plus/test";
import { costOf } from "./cost.ts";

const pricing = { inputPerMillion: 0.3, cachedInputPerMillion: 0.006, outputPerMillion: 1.2 };

describe("costOf", () => {
  it("prices uncached input, cached input and output separately", () => {
    const usage = { inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 100_000 };
    // 600k uncached × $0.30/M + 400k cached × $0.006/M + 100k output × $1.20/M
    expect(costOf(usage, pricing)).toBeCloseTo(0.18 + 0.0024 + 0.12);
  });

  it("is zero when nothing was used", () => {
    expect(costOf({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }, pricing)).toBe(0);
  });
});
