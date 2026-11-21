import * as z from "zod";
import { defineTool, fail, ok } from "../tool.ts";
import type { Tool } from "../tool.ts";
import { truncateMiddle } from "../truncate.ts";

export type ApproveCommand = (command: string) => Promise<boolean>;

export type RunCommandOptions = {
  approve: ApproveCommand;
  timeoutMs?: number;
  // Every character of output is sent back to the model on every later step, so keep it bounded.
  maxOutputChars?: number;
};

export const createRunCommandTool = ({
  approve,
  timeoutMs = 60_000,
  maxOutputChars = 10_000,
}: RunCommandOptions): Tool =>
  defineTool({
    name: "run_command",
    description: `Run a shell command in the working directory. Returns the exit code and the combined stdout and stderr. Commands get no stdin, so they must not prompt for input. They are killed after ${timeoutMs / 1000} seconds. Output longer than ${maxOutputChars} characters is cut in the middle.`,
    schema: z.object({ command: z.string().min(1) }),
    async run({ command }, { sandbox }) {
      if (!(await approve(command))) return fail("The user declined to run this command.");

      const result = await sandbox.exec(command, timeoutMs);
      const output = truncateMiddle(result.output, maxOutputChars);
      if (result.timedOut)
        return fail(`Command timed out after ${timeoutMs} ms and was killed.\n${output}`);
      return ok(`Exit code: ${String(result.exitCode)}\n${output}`);
    },
  });
