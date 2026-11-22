import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

// The Postgres from compose.yaml. Anything else (CI, deploys) sets DATABASE_URL.
export const LOCAL_DATABASE_URL = "postgres://burrow:burrow@127.0.0.1:5433/burrow";

export type Db = NodePgDatabase & { $client: Pool };

// Opens a connection pool. Call `db.$client.end()` when done, or the process will not exit.
export function createDb(url = process.env.DATABASE_URL ?? LOCAL_DATABASE_URL): Db {
  return drizzle({ client: new Pool({ connectionString: url }) });
}
