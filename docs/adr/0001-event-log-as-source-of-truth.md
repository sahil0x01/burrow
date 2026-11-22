# ADR 0001: The event log is the source of truth for a run

**Status:** accepted (2026-11-22, M3)

## Context

A run produces a stream of agent events (model calls, tool calls, tool results, done). Several readers need them: a client watching live over SSE, a client that reconnects after losing its connection, and later replay/resume (M8), evals (M6) and tracing (M9). We need one place they all read from.

## Decision

Every agent event is stored as a row in an append-only `events` table, numbered `seq = 1, 2, 3, …` per run, with primary key `(run_id, seq)`. Rows are inserted, never updated. The `runs` row keeps only a small summary (`status`, timestamps) for listing runs; anything it holds can be rebuilt from the events. Each event has a `type` and a `version`, so the shape of `data` can change without breaking old rows. SSE uses `seq` as the event id, so a client resumes with `Last-Event-ID: <seq>` and gets every event after it.

## Options considered

- **Mutable `runs` row only** (update status/output columns as the run goes). Simple, but history is lost, a reconnecting client cannot catch up, and replay is impossible.
- **Push events straight to clients** (in-memory pub/sub, no storage). Fast, but a client that disconnects misses events for good, and nothing survives a server restart.
- **External log** (Kafka, Redis Streams). Built for this, but a second system to run and keep consistent with Postgres. Postgres is enough at our scale.

## Consequences

- Clients can always catch up: read events with `seq > last seen`, in order.
- A per-run sequence number has to be assigned without gaps or duplicates; the primary key rejects duplicates.
- The `events` table grows forever. Retention or archiving is a later problem (not before M9).
- `runs.status` can drift from the events if code updates one and not the other, so both are written in the same transaction.
