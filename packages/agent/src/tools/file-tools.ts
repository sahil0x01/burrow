import * as z from "zod";
import { defineTool, ok } from "../tool.ts";

export const readFileTool = defineTool({
  name: "read_file",
  description: "Read a UTF-8 text file. The path is relative to the working directory.",
  schema: z.object({ path: z.string().min(1) }),
  async run({ path }, { sandbox }) {
    return ok(await sandbox.readFile(path));
  },
});

export const writeFileTool = defineTool({
  name: "write_file",
  description:
    "Create or overwrite a UTF-8 text file with the given content. Parent directories are created. The path is relative to the working directory.",
  schema: z.object({ path: z.string().min(1), content: z.string() }),
  async run({ path, content }, { sandbox }) {
    await sandbox.writeFile(path, content);
    return ok(`Wrote ${Buffer.byteLength(content)} bytes to ${path}`);
  },
});
