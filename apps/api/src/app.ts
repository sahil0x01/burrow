import { createRun, getRepo, getRun, type Db } from "@burrow/db";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

export type AppOptions = {
  db: Db;
  // Every request must send `Authorization: Bearer <apiKey>`.
  apiKey: string;
};

const createRunBody = z.object({
  repoId: z.uuid(),
  task: z.string().trim().min(1).max(10_000),
});

const runParams = z.object({ id: z.uuid() });

export function createApp({ db, apiKey }: AppOptions) {
  const app = new Hono();

  // Compares keys in constant time, so response timing does not leak how much of a guess matched.
  app.use(bearerAuth({ token: apiKey }));

  app.post(
    "/runs",
    zValidator("json", createRunBody, (result, c) =>
      result.success ? undefined : c.json({ error: z.prettifyError(result.error) }, 400),
    ),
    async (c) => {
      const { repoId, task } = c.req.valid("json");
      if (!(await getRepo(db, repoId))) {
        return c.json({ error: `Repo not found: ${repoId}` }, 404);
      }
      const run = await createRun(db, { repoId, task });
      return c.json(run, 201);
    },
  );

  app.get(
    "/runs/:id",
    // An id that is not a UUID gets 404 here, instead of reaching Postgres and failing there.
    zValidator("param", runParams, (result, c) =>
      result.success ? undefined : c.json({ error: "Run not found" }, 404),
    ),
    async (c) => {
      const run = await getRun(db, c.req.valid("param").id);
      if (!run) {
        return c.json({ error: "Run not found" }, 404);
      }
      return c.json(run);
    },
  );

  app.notFound((c) => c.json({ error: "Not found" }, 404));

  app.onError((error, c) => {
    // Errors Hono throws on purpose (like bearerAuth's 401) carry their own response.
    if (error instanceof HTTPException) {
      return error.getResponse();
    }
    // Anything else is a bug: details go to the server log, never to the client.
    console.error(error);
    return c.json({ error: "Internal server error" }, 500);
  });

  return app;
}
