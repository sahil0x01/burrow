import * as z from "zod";
import type { ToolDefinition } from "./llm.ts";
import type { Sandbox } from "./sandbox.ts";

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
      json = JSON.parse(rawArguments);
    } catch {
      return fail(`Arguments are not valid JSON: ${rawArguments}`);
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
