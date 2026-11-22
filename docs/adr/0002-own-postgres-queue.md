# ADR 0002: Our own job queue in Postgres

**Status:** accepted (2026-11-22, M4)

## Context

In M3 the API runs the agent inside its own process. If the API stops, every run in it stops and stays `running` forever, and one process does all the work. We need runs to be picked up by separate worker processes, never by two workers at once, and retried when an attempt crashes. Postgres is already our only stateful system.

## Decision

A `jobs` table in Postgres is the queue. The API inserts the run and its job in one transaction. Workers claim a job with one statement:

```sql
update jobs set status = 'running', attempts = attempts + 1, locked_by = $worker, locked_at = now()
where id = (
  select id from jobs where status = 'queued' and run_at <= now()
  order by run_at, id
  for update skip locked
  limit 1
)
returning *;
```

`FOR UPDATE` locks the chosen row; `SKIP LOCKED` makes other workers skip rows that are locked instead of waiting, so each claims a different job. A partial index on queued jobs keeps the search cheap. Each job has a unique `key` (`run:<id>`), so enqueueing the same work twice does nothing. A failed attempt goes back to `queued` with a later `run_at` (backoff) until `max_attempts`. Workers poll; `LISTEN/NOTIFY` can wake them sooner later. Runs (what users see) and jobs (how work is delivered) are separate tables.

## Options considered

- **pg-boss.** A mature Postgres queue built on the same `SKIP LOCKED` idea, with retries, expiry and scheduling. This is what we would use in production. Not here: it hides the mechanism this milestone is about, and its own expiry and retry would overlap with the leases and heartbeats we build in M8.
- **BullMQ on Redis.** Fast and popular, but a second stateful system to run, and the job and the run would live in different databases, so they could not be written in one transaction.
- **Queue columns on `runs`.** Fewer tables, but mixes the user's view of a run with delivery details (attempts, locks), and the queue could not carry other kinds of work (M5 GitHub steps).

## Consequences

- A run is never lost between the API and a worker: the run and its job commit together, or not at all.
- Delivery is **at least once**: a job can be attempted more than once, so the work must be safe to repeat. Each attempt works on a fresh repo copy, and its events are appended after the earlier attempt's.
- A worker that dies mid-job leaves it `running` forever. M8 fixes this with leases and heartbeats on this same table.
- Polling adds up to one interval of delay before a job starts.
