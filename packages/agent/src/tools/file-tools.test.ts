import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { createLocalSandbox } from "../local-sandbox.ts";
import type { ToolContext } from "../tool.ts";
import { readFileTool, writeFileTool } from "./file-tools.ts";

let workdir: string;
let context: ToolContext;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "burrow-test-"));
  context = { sandbox: createLocalSandbox(workdir) };
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("write_file and read_file", () => {
  it("writes a file, creating parent directories, then reads it back", async () => {
    const write = await writeFileTool.execute(
      JSON.stringify({ path: "src/hello.txt", content: "hello" }),
      context,
    );
    expect(write).toEqual({ status: "ok", output: "Wrote 5 bytes to src/hello.txt" });
    expect(await readFile(join(workdir, "src/hello.txt"), "utf8")).toBe("hello");

    const read = await readFileTool.execute(JSON.stringify({ path: "src/hello.txt" }), context);
    expect(read).toEqual({ status: "ok", output: "hello" });
  });

  it("reports a missing file as an error result", async () => {
    const result = await readFileTool.execute(JSON.stringify({ path: "nope.txt" }), context);
    expect(result.status).toBe("error");
    expect(result.output).toContain("ENOENT");
  });

  it("refuses to write outside the working directory", async () => {
    const result = await writeFileTool.execute(
      JSON.stringify({ path: "../escape.txt", content: "x" }),
      context,
    );
    expect(result).toEqual({
      status: "error",
      output: "Path is outside the working directory: ../escape.txt",
    });
  });
});
