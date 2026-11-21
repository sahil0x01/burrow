// Shows what the Docker sandbox contains: the agent runs `rm -rf /` and this machine is fine.
// Docker only. Never point this at createLocalSandbox.
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDockerSandbox } from "@burrow/agent/docker";

// A file on this machine, outside the shared folder. It must survive.
const outsideDir = await mkdtemp(join(tmpdir(), "burrow-demo-outside-"));
const outsideFile = join(outsideDir, "precious.txt");
await writeFile(outsideFile, "still here");

// The shared folder. The agent is allowed to change this, so it will not survive.
const workdir = await mkdtemp(join(tmpdir(), "burrow-demo-workdir-"));
await writeFile(join(workdir, "README.md"), "# demo repo");

const sandbox = await createDockerSandbox({ workdir });
try {
  const attack = await sandbox.exec("rm -rf --no-preserve-root / 2>/dev/null; echo done", 60_000);
  console.log(`rm -rf / finished with exit code ${attack.exitCode}`);

  const after = await sandbox.exec("ls /usr/bin | wc -l; id -u", 10_000);
  console.log(`Inside the container afterwards:\n${after.output}`);
} finally {
  await sandbox.destroy();
}

console.log(`Outside file: "${await readFile(outsideFile, "utf8")}"`);
console.log(`Shared folder now holds: [${(await readdir(workdir)).join(", ")}]`);

// A fresh container starts clean, because every sandbox gets its own throwaway filesystem.
const fresh = await createDockerSandbox({ workdir });
try {
  console.log(`Fresh container: ${(await fresh.exec("node --version", 10_000)).output.trim()}`);
} finally {
  await fresh.destroy();
  await rm(workdir, { recursive: true, force: true });
  await rm(outsideDir, { recursive: true, force: true });
}
