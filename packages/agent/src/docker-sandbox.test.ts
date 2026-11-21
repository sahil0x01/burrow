import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Docker from "dockerode";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createDockerSandbox } from "./docker-sandbox.ts";
import type { Sandbox } from "./sandbox.ts";

// These tests talk to a real Docker daemon. They are skipped where Docker is not running.
const dockerIsRunning = await new Docker()
  .ping()
  .then(() => true)
  .catch(() => false);

describe.skipIf(!dockerIsRunning)("createDockerSandbox", () => {
  let workdir: string;
  let sandbox: Sandbox;

  beforeAll(async () => {
    workdir = await mkdtemp(join(tmpdir(), "burrow-docker-test-"));
    sandbox = await createDockerSandbox({ workdir });
  }, 120_000);

  afterAll(async () => {
    await sandbox.destroy();
    await rm(workdir, { recursive: true, force: true });
  });

  it("writes and reads files in the shared folder", async () => {
    await sandbox.writeFile("src/hello.txt", "héllo");

    expect(await sandbox.readFile("src/hello.txt")).toBe("héllo");
    expect(await readFile(join(workdir, "src/hello.txt"), "utf8")).toBe("héllo");
  });

  it("reports a missing file as an error", async () => {
    await expect(sandbox.readFile("nope.txt")).rejects.toThrow("No such file");
  });

  it("runs commands in the shared folder and returns exit code and output", async () => {
    await sandbox.writeFile("note.txt", "from the host");

    expect(await sandbox.exec("cat note.txt; echo oops >&2; exit 3", 10_000)).toEqual({
      exitCode: 3,
      timedOut: false,
      output: "from the hostoops\n",
    });
  });

  it("kills a timed-out command together with its child processes", async () => {
    const started = Date.now();
    const result = await sandbox.exec("sleep 5; echo never printed", 500);

    expect(Date.now() - started).toBeLessThan(3_000);
    expect(result).toMatchObject({ timedOut: true, output: "" });
  });

  it("does not run as root", async () => {
    const result = await sandbox.exec("id -u", 10_000);
    expect(result.output.trim()).not.toBe("0");
  });

  it("has no network access", async () => {
    const script =
      "fetch('https://example.com').then(() => process.exit(0), () => process.exit(1))";
    const result = await sandbox.exec(`node -e "${script}"`, 10_000);
    expect(result.exitCode).toBe(1);
  });

  it("cannot see files outside the shared folder", async () => {
    const result = await sandbox.exec(`ls ${tmpdir()}`, 10_000);
    expect(result.exitCode).not.toBe(0);
  });
});
