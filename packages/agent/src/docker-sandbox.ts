import { PassThrough } from "node:stream";
import Docker from "dockerode";
import { createOutputBuffer, DEFAULT_MAX_OUTPUT_BYTES } from "./output-buffer.ts";
import type { OutputBuffer } from "./output-buffer.ts";
import type { CommandResult, Sandbox } from "./sandbox.ts";

export type DockerSandboxOptions = {
  workdir: string;
  image?: string;
  memoryMb?: number;
  cpus?: number;
  maxOutputBytes?: number;
  docker?: Docker;
};

type ExecOutput = { exitCode: number | null; stdout: string; stderr: string; combined: string };

const WORKSPACE = "/workspace";

const ensureImage = async (docker: Docker, image: string): Promise<void> => {
  const present = await docker
    .getImage(image)
    .inspect()
    .then(() => true)
    .catch(() => false);
  if (present) return;

  const progress = await docker.pull(image);
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(progress, (error) => (error ? reject(error) : resolve()));
  });
};

// Runs one process inside the container and collects its output.
// stdout and stderr are kept separately and also interleaved in arrival order.
// Without `maxBytes` everything is kept, which file reads need.
const execIn = async (
  container: Docker.Container,
  cmd: string[],
  { stdin, maxBytes = Number.MAX_SAFE_INTEGER }: { stdin?: string; maxBytes?: number } = {},
): Promise<ExecOutput> => {
  const exec = await container.exec({
    Cmd: cmd,
    WorkingDir: WORKSPACE,
    AttachStdin: stdin !== undefined,
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({ hijack: true, stdin: stdin !== undefined });

  const stdout = createOutputBuffer(maxBytes);
  const stderr = createOutputBuffer(maxBytes);
  const combined = createOutputBuffer(maxBytes);
  const collect = (target: OutputBuffer) => {
    const sink = new PassThrough();
    sink.on("data", (chunk: Buffer) => {
      target.push(chunk);
      combined.push(chunk);
    });
    return sink;
  };
  container.modem.demuxStream(stream, collect(stdout), collect(stderr));

  if (stdin !== undefined) stream.end(stdin);

  await new Promise<void>((resolve, reject) => {
    stream.on("end", resolve);
    stream.on("error", reject);
  });

  const { ExitCode } = await exec.inspect();
  return {
    exitCode: ExitCode,
    stdout: stdout.text(),
    stderr: stderr.text(),
    combined: combined.text(),
  };
};

// One container per sandbox. Only `workdir` is shared with this machine (as /workspace);
// everything else the agent sees is the container's own throwaway filesystem.
export const createDockerSandbox = async (options: DockerSandboxOptions): Promise<Sandbox> => {
  const docker = options.docker ?? new Docker();
  const image = options.image ?? "node:24-slim";
  await ensureImage(docker, image);

  // Run as the same user id as this machine's user, so files in the shared folder keep
  // the right owner on Linux. Never run as root, even if this program does.
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  const user = uid === 0 ? "1000:1000" : `${uid}:${gid}`;

  const container = await docker.createContainer({
    Image: image,
    Cmd: ["sleep", "infinity"],
    WorkingDir: WORKSPACE,
    User: user,
    Env: ["HOME=/tmp"],
    Labels: { "burrow.sandbox": "true" },
    HostConfig: {
      Binds: [`${options.workdir}:${WORKSPACE}`],
      NetworkMode: "none",
      Memory: (options.memoryMb ?? 512) * 1024 * 1024,
      NanoCpus: (options.cpus ?? 1) * 1_000_000_000,
      PidsLimit: 256,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
    },
  });
  await container.start();

  return {
    async readFile(path) {
      const result = await execIn(container, ["cat", "--", path]);
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Cannot read ${path}`);
      return result.stdout;
    },

    async writeFile(path, content) {
      const script = 'mkdir -p "$(dirname "$1")" && cat > "$1"';
      const result = await execIn(container, ["sh", "-c", script, "sh", path], { stdin: content });
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Cannot write ${path}`);
    },

    async exec(command, timeoutMs): Promise<CommandResult> {
      const started = Date.now();
      const seconds = String(timeoutMs / 1000);
      const result = await execIn(
        container,
        ["timeout", "-s", "KILL", seconds, "sh", "-c", command],
        { maxBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES },
      );
      // `timeout` kills the command's whole process group and exits with 137 (128 + SIGKILL).
      const timedOut = result.exitCode === 137 && Date.now() - started >= timeoutMs;
      return { exitCode: result.exitCode, timedOut, output: result.combined };
    },

    async destroy() {
      await container.remove({ force: true });
    },
  };
};
