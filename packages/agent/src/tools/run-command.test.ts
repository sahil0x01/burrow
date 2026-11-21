import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { createLocalSandbox } from "../local-sandbox.ts";
import type { ToolContext } from "../tool.ts";
import { createRunCommandTool } from "./run-command.ts";

let workdir: string;
let context: ToolContext;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "burrow-test-"));
  context = { sandbox: createLocalSandbox(workdir) };
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

const approveAll = async () => true;
const run = (command: string, timeoutMs?: number) =>
  createRunCommandTool({ approve: approveAll, timeoutMs }).execute(
    JSON.stringify({ command }),
    context,
  );

describe("run_command", () => {
  it("runs in the working directory and returns exit code and output", async () => {
    await writeFile(join(workdir, "hello.txt"), "hello from the workdir");
    expect(await run("cat hello.txt")).toEqual({
      status: "ok",
      output: "Exit code: 0\nhello from the workdir",
    });
  });

  it("treats a non-zero exit code as a normal result, including stderr", async () => {
    expect(await run("echo oops >&2; exit 3")).toEqual({
      status: "ok",
      output: "Exit code: 3\noops\n",
    });
  });

  it("kills a timed-out command together with its child processes", async () => {
    const started = Date.now();
    const result = await run("sleep 5; echo never printed", 100);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.status).toBe("error");
    expect(result.output).toContain("timed out after 100 ms");
  });

  it("does not run the command when the user declines", async () => {
    const tool = createRunCommandTool({ approve: async () => false });
    const result = await tool.execute(JSON.stringify({ command: "touch created.txt" }), context);
    expect(result).toEqual({ status: "error", output: "The user declined to run this command." });
    expect(existsSync(join(workdir, "created.txt"))).toBe(false);
  });
});
