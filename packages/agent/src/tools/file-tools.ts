import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import * as z from "zod";
import { defineTool, fail, ok } from "../tool.ts";

export const resolveInWorkdir = (workdir: string, path: string): string | undefined => {
  const full = resolve(workdir, path);
  const fromWorkdir = relative(workdir, full);
  if (fromWorkdir === ".." || fromWorkdir.startsWith(`..${sep}`) || isAbsolute(fromWorkdir)) {
    return undefined;
  }
  return full;
};

export const readFileTool = defineTool({
  name: "read_file",
  description: "Read a UTF-8 text file. The path is relative to the working directory.",
  schema: z.object({ path: z.string().min(1) }),
  async run({ path }, { workdir }) {
    const full = resolveInWorkdir(workdir, path);
    if (!full) return fail(`Path is outside the working directory: ${path}`);
    return ok(await readFile(full, "utf8"));
  },
});

export const writeFileTool = defineTool({
  name: "write_file",
  description:
    "Create or overwrite a UTF-8 text file with the given content. Parent directories are created. The path is relative to the working directory.",
  schema: z.object({ path: z.string().min(1), content: z.string() }),
  async run({ path, content }, { workdir }) {
    const full = resolveInWorkdir(workdir, path);
    if (!full) return fail(`Path is outside the working directory: ${path}`);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
    return ok(`Wrote ${Buffer.byteLength(content)} bytes to ${path}`);
  },
});
