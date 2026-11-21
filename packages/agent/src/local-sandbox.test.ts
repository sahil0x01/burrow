import { tmpdir } from "node:os";
import { describe, expect, it } from "vite-plus/test";
import { resolveInWorkdir, runShell } from "./local-sandbox.ts";

describe("resolveInWorkdir", () => {
  it("allows paths inside the working directory", () => {
    expect(resolveInWorkdir("/work", "src/a.ts")).toBe("/work/src/a.ts");
    expect(resolveInWorkdir("/work", "..notes.md")).toBe("/work/..notes.md");
  });

  it("rejects paths that escape it", () => {
    expect(resolveInWorkdir("/work", "../secret")).toBeUndefined();
    expect(resolveInWorkdir("/work", "src/../../secret")).toBeUndefined();
    expect(resolveInWorkdir("/work", "/etc/passwd")).toBeUndefined();
  });
});

describe("runShell", () => {
  it("keeps memory bounded for endless output", async () => {
    const result = await runShell("yes", tmpdir(), 500, 1_000);

    expect(result.timedOut).toBe(true);
    expect(result.output).toContain("bytes omitted");
    expect(result.output.length).toBeLessThan(1_100);
  });
});
