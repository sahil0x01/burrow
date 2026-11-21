import { describe, expect, it } from "vite-plus/test";
import { resolveInWorkdir } from "./local-sandbox.ts";

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
