import { createRun, getRepo, getRun, listEventsAfter, type Db } from "@burrow/db";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { z } from "zod";

export type AppOptions = {
  db: Db;
  // Every request must send `Authorization: Bearer <apiKey>`.
  apiKey: string;
  // How often an open event stream checks the database for new events. Default 500 ms.
  pollIntervalMs?: number;
};

const createRunBody = z.object({
  repoId: z.uuid(),
  task: z.string().trim().min(1).max(10_000),
});

const runParams = z.object({ id: z.uuid() });

export function createApp({ db, apiKey, pollIntervalMs = 500 }: AppOptions) {
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

  // Streams a run's events as Server-Sent Events, each with `id: <seq>`. A client that
  // reconnects sends `Last-Event-ID: <seq>` and gets only the events after it.
  // The stream ends once the run has finished and every event has been sent.
  app.get(
    "/runs/:id/events",
    zValidator("param", runParams, (result, c) =>
      result.success ? undefined : c.json({ error: "Run not found" }, 404),
    ),
    async (c) => {
      const runId = c.req.valid("param").id;
      const lastEventId = c.req.header("Last-Event-ID") ?? "0";
      if (!/^\d{1,9}$/.test(lastEventId)) {
        return c.json({ error: "Last-Event-ID must be a whole number" }, 400);
      }
      if (!(await getRun(db, runId))) {
        return c.json({ error: "Run not found" }, 404);
      }

      return streamSSE(c, async (stream) => {
        let lastSeq = Number(lastEventId);
        // `aborted` turns true when the client disconnects, so the loop stops polling.
        while (!stream.aborted) {
          // Read the status BEFORE the events. The final event and the final status are
          // written in one transaction, so if we already see the run as finished, the
          // events read next are sure to include its last one.
          const finished = (await getRun(db, runId))?.status !== "running";

          for (const event of await listEventsAfter(db, runId, lastSeq)) {
            await stream.writeSSE({
              id: String(event.seq),
              event: event.type,
              data: JSON.stringify(event.data),
            });
            lastSeq = event.seq;
          }

          if (finished) return;
          await stream.sleep(pollIntervalMs);
        }
      });
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
