import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createDb, createRepo } from "@burrow/db";

// Registers a folder on this machine as a repo runs can use, and prints its id.
// The API has no endpoint for this on purpose: only someone with shell access here can
// decide which folders the agent may touch.
const usage = "Usage: node apps/api/src/add-repo.ts <name> <folder>";

const [name, folder] = process.argv.slice(2);
if (!name || !folder) {
  console.error(usage);
  process.exit(2);
}

const path = resolve(folder);
if (!(await stat(path).catch(() => undefined))?.isDirectory()) {
  console.error(`Not a folder: ${path}`);
  process.exit(2);
}

const db = createDb();
try {
  const repo = await createRepo(db, { name, path });
  console.log(`Added repo ${repo.name} (${repo.path})`);
  console.log(`id: ${repo.id}`);
} finally {
  await db.$client.end();
}
