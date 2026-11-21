// Command output can be endless (`yes`, a runaway log). Keeping all of it would use up this
// process's memory before the timeout fires, so a sandbox keeps at most this much per command.
export const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;

export type OutputBuffer = {
  push(chunk: Buffer): void;
  text(): string;
};

// Keeps the first half of the limit and the most recent second half, and drops the middle
// as it arrives. Memory stays bounded no matter how much is pushed.
export const createOutputBuffer = (maxBytes: number): OutputBuffer => {
  const headLimit = Math.ceil(maxBytes / 2);
  const tailLimit = maxBytes - headLimit;
  const head: Buffer[] = [];
  const tail: Buffer[] = [];
  let headBytes = 0;
  let tailBytes = 0;
  let omittedBytes = 0;

  return {
    push(chunk) {
      let rest = chunk;
      if (headBytes < headLimit) {
        const taken = rest.subarray(0, headLimit - headBytes);
        head.push(taken);
        headBytes += taken.length;
        rest = rest.subarray(taken.length);
      }
      if (rest.length === 0) return;

      tail.push(rest);
      tailBytes += rest.length;
      // Drop the oldest tail bytes until the tail fits again.
      while (tailBytes > tailLimit) {
        const oldest = tail[0];
        if (!oldest) break;
        const excess = tailBytes - tailLimit;
        if (oldest.length <= excess) {
          tail.shift();
          tailBytes -= oldest.length;
          omittedBytes += oldest.length;
        } else {
          tail[0] = oldest.subarray(excess);
          tailBytes -= excess;
          omittedBytes += excess;
        }
      }
    },

    text() {
      // Nothing dropped: decode it all at once, so a character split across head and tail stays whole.
      if (omittedBytes === 0) return Buffer.concat([...head, ...tail]).toString("utf8");
      const start = Buffer.concat(head).toString("utf8");
      const end = Buffer.concat(tail).toString("utf8");
      return `${start}\n[... ${omittedBytes} bytes omitted ...]\n${end}`;
    },
  };
};
