import { describe, expect, it } from "vite-plus/test";
import { createOutputBuffer } from "./output-buffer.ts";

const fill = (maxBytes: number, ...chunks: string[]) => {
  const buffer = createOutputBuffer(maxBytes);
  for (const chunk of chunks) buffer.push(Buffer.from(chunk));
  return buffer.text();
};

describe("createOutputBuffer", () => {
  it("keeps everything that fits", () => {
    expect(fill(10, "abc", "def")).toBe("abcdef");
  });

  it("keeps the start and the latest end, and says how much was dropped", () => {
    expect(fill(4, "ab", "cdef", "gh", "ij")).toBe("ab\n[... 6 bytes omitted ...]\nij");
  });

  it("does not break a character that spans two chunks when nothing is dropped", () => {
    const euro = Buffer.from("€"); // 3 bytes
    const buffer = createOutputBuffer(4);
    buffer.push(euro.subarray(0, 1));
    buffer.push(euro.subarray(1));
    expect(buffer.text()).toBe("€");
  });

  it("stays bounded however much is pushed", () => {
    const buffer = createOutputBuffer(100);
    for (let i = 0; i < 10_000; i++) buffer.push(Buffer.from("y\n"));
    const text = buffer.text();
    expect(text).toContain("19900 bytes omitted");
    expect(text.length).toBeLessThan(150);
  });
});
