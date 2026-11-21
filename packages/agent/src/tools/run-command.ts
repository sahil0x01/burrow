import * as z from "zod";
import { defineTool, fail, ok } from "../tool.ts";
import type { Tool } from "../tool.ts";

export type ApproveCommand = (command: string) => Promise<boolean>;

export type RunCommandOptions = { approve: ApproveCommand; timeoutMs?: number };

export const createRunCommandTool = ({ approve, timeoutMs = 60_000 }: RunCommandOptions): Tool =>
  defineTool({
    name: "run_command",
    description: `Run a shell command in the working directory. Returns the exit code and the combined stdout and stderr. Commands get no stdin, so they must not prompt for input. They are killed after ${timeoutMs / 1000} seconds.`,
    schema: z.object({ command: z.string().min(1) }),
    async run({ command }, { sandbox }) {
      if (!(await approve(command))) return fail("The user declined to run this command.");

      const { exitCode, timedOut, output } = await sandbox.exec(command, timeoutMs);
      if (timedOut)
        return fail(`Command timed out after ${timeoutMs} ms and was killed.\n${output}`);
      return ok(`Exit code: ${String(exitCode)}\n${output}`);
    },
  });
