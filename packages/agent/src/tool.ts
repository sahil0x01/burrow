import * as z from "zod";
import type { ToolDefinition } from "./llm.ts";
import type { Sandbox } from "./sandbox.ts";
import { truncateMiddle } from "./truncate.ts";

export type ToolContext = { sandbox: Sandbox };

export type ToolResult = { status: "ok" | "error"; output: string };

export type Tool = {
  definition: ToolDefinition;
  execute(rawArguments: string, context: ToolContext): Promise<ToolResult>;
};

export const ok = (output: string): ToolResult => ({ status: "ok", output });
export const fail = (output: string): ToolResult => ({ status: "error", output });

type ToolSpec<Schema extends z.ZodType> = {
  name: string;
  description: string;
  schema: Schema;
  run(args: z.output<Schema>, context: ToolContext): Promise<ToolResult>;
};

export const defineTool = <Schema extends z.ZodType>(spec: ToolSpec<Schema>): Tool => ({
  definition: {
    name: spec.name,
    description: spec.description,
    parameters: z.toJSONSchema(spec.schema),
  },
  async execute(rawArguments, context) {
    let json: unknown;
    try {
      // Some models send "" instead of "{}" when they pass no arguments.
      json = JSON.parse(rawArguments.trim() === "" ? "{}" : rawArguments);
    } catch {
      // Show only part of it: broken arguments are often a whole file the model tried to write.
      return fail(`Arguments are not valid JSON: ${truncateMiddle(rawArguments, 500)}`);
    }

    const parsed = spec.schema.safeParse(json);
    if (!parsed.success) return fail(`Invalid arguments:\n${z.prettifyError(parsed.error)}`);

    try {
      return await spec.run(parsed.data, context);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
});
