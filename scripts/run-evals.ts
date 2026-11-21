import { cp, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import * as z from "zod";
import {
  CODING_AGENT_SYSTEM_PROMPT,
  createLocalSandbox,
  createRunCommandTool,
  readFileTool,
  runAgent,
  writeFileTool,
} from "@burrow/agent";
import { createDeepSeekLLM, deepSeekFlashPricing } from "@burrow/agent/deepseek";
import { createDockerSandbox } from "@burrow/agent/docker";

// Nobody is at the keyboard during evals, so only these exact commands are approved.
const ALLOWED_COMMANDS = new Set(["npm test", "node --test", "ls", "ls -la", "ls -R"]);

const TaskSchema = z.object({
  name: z.string().min(1),
  prompt: z.string().min(1),
  check: z.string().min(1),
});
type Task = z.infer<typeof TaskSchema>;

type TaskReport = {
  task: string;
  passed: boolean;
  outcome: string;
  steps: number;
  costUsd: number;
  seconds: number;
  workdir: string;
};

// Evals run in Docker by default, the same way the CLI does, so they measure what ships.
const { values } = parseArgs({
  options: { sandbox: { type: "string", default: "docker" } },
});
if (values.sandbox !== "docker" && values.sandbox !== "local") {
  throw new Error(`--sandbox must be "docker" or "local", got "${values.sandbox}"`);
}
const sandboxKind = values.sandbox;

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) throw new Error("DEEPSEEK_API_KEY is not set");
const llm = createDeepSeekLLM({ apiKey, model: "deepseek-flash" });

const runTask = async (task: Task): Promise<TaskReport> => {
  const fixtureDir = join("fixtures", task.name);
  const workdir = await mkdtemp(join(tmpdir(), `burrow-eval-${task.name}-`));
  await cp(fixtureDir, workdir, { recursive: true });
  const sandbox =
    sandboxKind === "local" ? createLocalSandbox(workdir) : await createDockerSandbox({ workdir });

  try {
    const started = Date.now();
    const result = await runAgent({
      llm,
      tools: [
        readFileTool,
        writeFileTool,
        createRunCommandTool({ approve: async (command) => ALLOWED_COMMANDS.has(command.trim()) }),
      ],
      context: { sandbox },
      systemPrompt: CODING_AGENT_SYSTEM_PROMPT,
      task: task.prompt,
      maxSteps: 20,
      pricing: deepSeekFlashPricing,
      maxCostUsd: 0.05,
    });
    const seconds = (Date.now() - started) / 1000;

    // Put the original tests back, so an agent cannot "pass" by editing the tests.
    await cp(join(fixtureDir, "test"), join(workdir, "test"), { recursive: true, force: true });
    const check = await sandbox.exec(task.check, 60_000);

    return {
      task: task.name,
      passed: check.exitCode === 0,
      outcome: result.outcome === "done" ? "done" : result.reason,
      steps: result.steps,
      costUsd: result.costUsd,
      seconds,
      workdir,
    };
  } finally {
    await sandbox.destroy();
  }
};

const tasks = z.array(TaskSchema).parse(JSON.parse(await readFile("fixtures/tasks.json", "utf8")));

const reports: TaskReport[] = [];
for (const task of tasks) {
  console.log(`▶ ${task.name}`);
  reports.push(await runTask(task));
}

console.table(
  reports.map((report) => ({
    task: report.task,
    passed: report.passed ? "✅" : "❌",
    outcome: report.outcome,
    steps: report.steps,
    cost: `$${report.costUsd.toFixed(5)}`,
    seconds: report.seconds.toFixed(1),
  })),
);

const passed = reports.filter((report) => report.passed).length;
const totalCost = reports.reduce((sum, report) => sum + report.costUsd, 0);
console.log(`Sandbox: ${sandboxKind}`);
console.log(`Passed ${passed}/${reports.length} · total cost $${totalCost.toFixed(5)}`);
console.log("Work folders (inspect what the agent did):");
for (const report of reports) console.log(`  ${report.task}: ${report.workdir}`);
