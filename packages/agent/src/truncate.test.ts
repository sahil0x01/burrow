import { describe, expect, it } from "vite-plus/test";
import { truncateMiddle } from "./truncate.ts";

describe("truncateMiddle", () => {
  it("leaves text within the limit unchanged", () => {
    expect(truncateMiddle("hello", 5)).toBe("hello");
  });

  it("keeps the start and the end and says how much was cut", () => {
    expect(truncateMiddle("abcdefghij", 4)).toBe("ab\n[... 6 characters omitted ...]\nij");
  });

  it("keeps one more character at the start when the limit is odd", () => {
    expect(truncateMiddle("abcdefghij", 5)).toBe("abc\n[... 5 characters omitted ...]\nij");
  });
});
