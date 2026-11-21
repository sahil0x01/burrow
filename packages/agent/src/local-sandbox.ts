import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { CommandResult, Sandbox } from "./sandbox.ts";

export const resolveInWorkdir = (workdir: string, path: string): string | undefined => {
  const full = resolve(workdir, path);
  const fromWorkdir = relative(workdir, full);
  if (fromWorkdir === ".." || fromWorkdir.startsWith(`..${sep}`) || isAbsolute(fromWorkdir)) {
    return undefined;
  }
  return full;
};

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

// Runs everything directly on this machine, inside `workdir`. Unsafe on purpose:
// commands can still reach the rest of the computer. Use it for tests and trusted repos.
export const createLocalSandbox = (workdir: string): Sandbox => {
  const inside = (path: string): string => {
    const full = resolveInWorkdir(workdir, path);
    if (!full) throw new Error(`Path is outside the working directory: ${path}`);
    return full;
  };

  return {
    async readFile(path) {
      return fs.readFile(inside(path), "utf8");
    },
    async writeFile(path, content) {
      const full = inside(path);
      await fs.mkdir(dirname(full), { recursive: true });
      await fs.writeFile(full, content, "utf8");
    },
    async exec(command, timeoutMs) {
      return runShell(command, workdir, timeoutMs);
    },
    async destroy() {
      // Nothing to clean up: the folder belongs to whoever created the sandbox.
    },
  };
};
