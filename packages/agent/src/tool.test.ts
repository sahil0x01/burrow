import * as z from "zod";
import { describe, expect, it } from "vite-plus/test";
import { defineTool, ok } from "./tool.ts";

const echo = defineTool({
  name: "echo",
  description: "Echo the text back.",
  schema: z.object({ text: z.string() }),
  async run({ text }) {
    if (text === "boom") throw new Error("exploded");
    return ok(text);
  },
});

const context = { workdir: "/unused" };

describe("defineTool", () => {
  it("runs the tool with parsed arguments", async () => {
    expect(await echo.execute('{"text":"hi"}', context)).toEqual({ status: "ok", output: "hi" });
  });

  it("returns an error result for malformed JSON", async () => {
    const result = await echo.execute('{"text":', context);
    expect(result.status).toBe("error");
    expect(result.output).toContain("not valid JSON");
  });

  it("returns an error result for arguments that fail the schema", async () => {
    const result = await echo.execute('{"text":42}', context);
    expect(result.status).toBe("error");
    expect(result.output).toContain("text");
  });

  it("turns a thrown error into an error result", async () => {
    expect(await echo.execute('{"text":"boom"}', context)).toEqual({
      status: "error",
      output: "exploded",
    });
  });

  it("exposes a JSON Schema for the model", () => {
    expect(echo.definition.parameters).toMatchObject({
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    });
  });
});
