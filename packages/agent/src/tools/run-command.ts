import { spawn } from "node:child_process";
import * as z from "zod";
import { defineTool, fail, ok } from "../tool.ts";
import type { Tool } from "../tool.ts";

export type CommandResult = { exitCode: number | null; timedOut: boolean; output: string };

export const runShell = (command: string, cwd: string, timeoutMs: number): Promise<CommandResult> =>
  new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", command], {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      output += chunk;
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        // The process group already exited between the timer firing and this call.
      }
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, timedOut, output });
    });
  });

export type ApproveCommand = (command: string) => Promise<boolean>;

export type RunCommandOptions = { approve: ApproveCommand; timeoutMs?: number };

export const createRunCommandTool = ({ approve, timeoutMs = 60_000 }: RunCommandOptions): Tool =>
  defineTool({
    name: "run_command",
    description: `Run a shell command in the working directory. Returns the exit code and the combined stdout and stderr. Commands get no stdin, so they must not prompt for input. They are killed after ${timeoutMs / 1000} seconds.`,
    schema: z.object({ command: z.string().min(1) }),
    async run({ command }, { workdir }) {
      if (!(await approve(command))) return fail("The user declined to run this command.");

      const { exitCode, timedOut, output } = await runShell(command, workdir, timeoutMs);
      if (timedOut)
        return fail(`Command timed out after ${timeoutMs} ms and was killed.\n${output}`);
      return ok(`Exit code: ${String(exitCode)}\n${output}`);
    },
  });
