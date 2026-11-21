# Burrow: Build Plan

Burrow is a cloud coding agent (task in, pull request out). Package scope `@burrow/*`, hosted at `burrow.sahil.fyi`.

A learning-first, evolutionary roadmap. We never "finish" a subsystem. Each one gets a **v1 (make it work), v2 (make it good), v3 (make it production-grade)** across milestones, and every milestone ends in something demoable.

---

## 1. How we work (teaching protocol)

Every step follows the same loop:

1. **Concept**: the idea in plain words (e.g. what is tool calling, what is a lease).
2. **Options**: 2–3 ways to do it, with tradeoffs.
3. **Decision**: what we pick and why, now. Recorded as a short ADR in `docs/adr/NNNN-title.md`.
4. **Code**: you write it with me. I explain it line by line when it is new or tricky.
5. **Break it**: we deliberately trigger the failure the design is meant to handle.
6. **Test**: unit or integration test, plus a manual demo.
7. **Interview card**: 3–5 questions you should now be able to answer. Saved in `docs/interview-notes.md`.

**Working agreement:** Claude explains and provides the code. **You type it yourself**, create and edit files, run commands, and do all git commits and pushes. Claude does not write project files or run git. When something breaks, you paste the error and we debug together.

**Definition of done for any milestone:** demo works, tests pass, ADR written, you can explain the design without looking at the code.

---

## 2. Locked-in stack (and the alternative we rejected)

| Concern              | Choice                                                                                                                 | Rejected / revisit later                                                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language             | TypeScript (strict), Node 24 LTS (supported to April 2028)                                                             | Node 22 (end-of-life April 2027, mid-project), Node 26 (native deps may lag)                                                                            |
| Toolchain / monorepo | Vite+ (`vp`: Vite, Vitest, Oxlint, Oxfmt, tsdown, monorepo task runner) on pnpm workspaces                             | Turborepo/Nx + ESLint + Prettier + separate configs (more moving parts)                                                                                 |
| LLM access           | DeepSeek API (OpenAI-compatible) via the `openai` npm SDK, own agent loop, behind our own `LLM` interface from day one | LangChain / AI SDK for the loop (hides what we want to learn). Claude as a second provider in M13 for comparison                                        |
| API                  | Hono                                                                                                                   | Express (older), NestJS (too much ceremony)                                                                                                             |
| DB                   | Postgres 18 (native `uuidv7()`) + Drizzle ORM                                                                          | Prisma (heavier), Mongo (we want relational + transactions)                                                                                             |
| Queue                | Own `jobs` table on `SELECT … FOR UPDATE SKIP LOCKED` (M4); leases/heartbeats extend the same table in M8              | pg-boss (hides the mechanism and brings its own expiry/retry that would duplicate our M8 leases; named in the ADR as the production pick), BullMQ/Redis |
| Sandbox              | Docker via dockerode, hardened later (gVisor/rootless)                                                                 | Firecracker (ops-heavy), hosted sandboxes (hide the learning)                                                                                           |
| Validation           | Zod                                                                                                                    |                                                                                                                                                         |
| Tests                | Vitest (via Vite+)                                                                                                     |                                                                                                                                                         |
| Streaming            | SSE                                                                                                                    | WebSocket (we only need server to client; see ADR)                                                                                                      |
| Web UI               | Next.js (App Router), UI only. The backend stays in Hono + worker                                                      | Vite SPA (simpler, but Next.js is what job posts ask for)                                                                                               |
| Durable execution    | Hand-built on Postgres (event log + leases) so we learn the concepts                                                   | Temporal / DBOS / Inngest / Restate. Compared in the M8 ADR, optional port in M8b                                                                       |
| Observability        | OpenTelemetry + Langfuse (or similar)                                                                                  |                                                                                                                                                         |
| Local infra          | Docker Compose (Postgres), added in M3 when first needed                                                               |                                                                                                                                                         |
| CI                   | GitHub Actions running `vp check` + tests on every push, from M0                                                       |                                                                                                                                                         |

---

## 3. Target architecture (where we are heading)

```
 Web UI ──HTTP/SSE──▶ API (Hono) ──▶ Postgres (runs, events, jobs, evals)
                         │                 ▲
                         ▼                 │
              Queue (jobs table)           │
                         │                 │
                         ▼                 │
                 Worker (agent runner) ────┘   append-only event log
                    │         │
                    ▼         ▼
              LLM API     Sandbox (container per run)
                              └─ repo checkout, shell, tests
                    │
                    ▼
               GitHub (clone, branch, push, PR)
```

Key ideas that run through everything:

- **Event log is the source of truth.** The UI, replay, resume, evals and tracing all read the same append-only events.
- **Agent core is pure and environment-agnostic**: it talks to a `Sandbox` interface and an `LLM` interface, so we can fake both in tests.
- **Workers are disposable.** Any worker can die at any time without losing a run.

### Target repo layout (grows over time; we do not create it all up front)

```
apps/
  api/        HTTP + SSE
  worker/     job consumer, runs the agent
  web/        Next.js UI (talks to the API; no business logic here)
  cli/        local dev client (M1)
packages/
  agent/      loop, tools, prompts, context management
  sandbox/    Sandbox interface + Docker implementation
  db/         Drizzle schema, migrations, queries
  shared/     event types, zod schemas
  evals/      task sets, runner, scoring
docs/adr/
```

---

## 4. The spiral: themes × milestones

Each row is a **theme** we return to. Each column is where it gets touched.

| Theme             | v1                                     | v2                                                   | v3                                                     |
| ----------------- | -------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------ |
| **Agent brain**   | M1 naive loop                          | M7 editing/search tools, context mgmt                | M13 planner, sub-agents, multi-model                   |
| **Sandbox**       | M2 Docker per run                      | M8 snapshot/restore                                  | M10 hardened (egress, limits, gVisor)                  |
| **Persistence**   | M3 runs + events                       | M4 job states                                        | M8 resume/replay                                       |
| **Durability**    | M4 own queue + retries                 | M8 leases, heartbeats, idempotency                   | M11 pause/resume for approval                          |
| **Evals**         | M1 hand-made tasks                     | M6 harness + metrics + M1 baseline                   | M13 SWE-bench Verified subset                          |
| **Observability** | M1 console events                      | M9 traces, cost, metrics                             | M13 eval dashboards                                    |
| **Security**      | M1 y/N confirm, M2 container isolation | M3 API key auth, M5 secrets kept outside the sandbox | M10 threat model, hardening, prompt-injection defenses |
| **UX**            | M1 CLI                                 | M3 SSE client                                        | M12 full web UI                                        |
| **Delivery**      | M0 CI                                  | M5 private deploy (behind auth)                      | M14 public deploy                                      |

---

## 5. Milestones

Time estimates are part-time (about 8–10 h/week) and rough.

### M0: Foundations (2–3 days)

**Goal:** repo, tooling, and the mental model.

- Node 24 LTS pinned, pnpm workspace + Vite+ (`vp`) for check/test/build/task running, strict tsconfig. Next.js keeps its own bundler, so Vite+ covers lint/format/test/tasks for it (verify when we get there). Postgres waits until M3, when we first need it
- CI: GitHub Actions running `vp check` and tests on every push
- Concepts: how LLM tool calling works on the wire (OpenAI-style `tool_calls` with JSON-string arguments and `role: "tool"` results), stop reasons, tokens, context window, prompt caching
- ADR 0001: monorepo and stack
- **Demo:** a 30-line script that makes one tool call by hand

### M1: Walking skeleton (1 week)

**Goal:** thinnest end-to-end agent. Task in, files changed, running on your machine.

- `packages/agent`: the loop (`while not done: call model, run tools, append results`)
- Tools v1: `read_file`, `write_file`, `run_command` (in a scratch dir, unsafe on purpose, but the CLI asks `y/N` before each command runs)
- Budget guard v1: hard max steps plus a token/cost cap that aborts the run
- Event emitter (typed events: `model_call`, `tool_call`, `tool_result`, `done`)
- CLI: `agent run "make the tests pass" --dir ./fixture`
- Recorded LLM fixtures: real DeepSeek responses saved and replayed by the fake `LLM`, so loop tests are deterministic and cost no tokens
- 3 hand-written toy tasks as the first eval
- Concepts: the agent loop, stop conditions, why tools return strings, error-as-observation
- **Demo:** agent fixes a failing test in a tiny fixture repo

### M2: Sandbox v1 and loop safety (1 week)

**Goal:** the agent no longer touches your machine.

- `Sandbox` interface (`exec`, `readFile`, `writeFile`, `destroy`) + Docker implementation
- Container per run: CPU/mem/pid limits, timeouts, no host mounts beyond a workdir
- Loop v2: wall-time budget (step/cost caps exist since M1), tool timeouts, output truncation, malformed-tool-call handling, loop detection
- Concepts: container isolation basics, why an interface (fakes for tests), exit codes vs errors
- **Demo:** same task, now inside a container. A malicious `rm -rf /` only hurts the container.

### M3: API, Postgres, event log, SSE (1 week)

**Goal:** a real backend you can hit with curl.

- Docker Compose with Postgres 18 (native `uuidv7()` for sortable IDs)
- DB design v1: `runs`, `events` (append-only, sequence per run), `repos`
- Endpoints: create run, get run, stream events (SSE with `Last-Event-ID` resume)
- Auth v1: a static API key checked by middleware, so the backend is never open once deployed
- Run still executes in-process (we feel the pain on purpose)
- Concepts: schema design for event logs, ordering/sequence numbers, SSE vs WebSocket, backpressure
- ADR: event log as source of truth
- **Demo:** `curl -N` shows a live run; kill the client and reconnect without losing events

### M4: Queue, worker, run lifecycle (1 week)

**Goal:** API and execution are separate processes.

- Run state machine: `queued → running → succeeded | failed | cancelled`
- Our own queue: a `jobs` table claimed with `SELECT … FOR UPDATE SKIP LOCKED` (about 100 lines), separate worker app, retries with backoff, cancellation signal. M8 adds leases and heartbeats to this same table
- Concepts: at-least-once delivery, idempotency, state machines, transactions, `SELECT … FOR UPDATE SKIP LOCKED`, `LISTEN/NOTIFY` vs polling
- ADR: our queue vs pg-boss vs BullMQ (what we would pick in production and why we did not here)
- **Demo:** start 2 workers, submit 5 runs, watch them spread out

### M5: GitHub integration, task to PR (1 week)

**Goal:** the first recruiter-grade demo.

- Auth: GitHub App or fine-grained token (ADR on the tradeoff)
- Clone into sandbox, create branch, commit inside the sandbox; the **worker pushes from outside** the sandbox and opens the PR with a generated description
- The GitHub token never enters the sandbox (no env var, no credential helper inside it): anything in the sandbox is readable by the agent, and a prompt-injected agent would exfiltrate it
- Private deploy v1 (single VPS + Compose, behind the API key), so ops surprises show up early instead of in M14
- Concepts: git plumbing, shallow clones, token scoping, trust boundaries
- **Demo:** "fix this issue" on a real small repo, then a real PR appears
- **Minimum portfolio checkpoint:** after M5 and M6 (harness with real numbers) you can start applying. Everything after is depth

### M6: Eval harness (1 week)

**Goal:** replace "it seems better" with numbers, before we start improving the agent.

- Task format (repo snapshot + task + success check), runner that executes N tasks in sandboxes in parallel
- Metrics: pass rate, steps, tokens, cost, wall time. Stored in DB, comparable across agent versions
- Variance handling (multiple trials), regression gate (runs in CI on a small, cheap subset)
- **Baseline:** score the unchanged M1-era agent. This is the X in the resume story
- **Demo:** baseline table of pass rate, steps and cost

### M7: Agent brain v2 (1.5 weeks)

**Goal:** the agent gets measurably better and we understand why.

- Tools v2: `str_replace` edit tool (vs whole-file writes), `grep`/`glob` via ripgrep, `list_dir`, a repo map
- Context management: tool-output truncation strategies, history compaction/summarization, prompt caching
- System prompt design and structure, few-shot vs instructions
- **Hill-climb loop:** change one thing (prompt, tool, compaction), re-run the evals, keep or revert. At least 3 documented experiments
- Concepts: why edit format matters, retrieval for code (grep vs embeddings), context rot, cost of tokens
- **Demo:** table showing pass rate and cost across agent versions, from the M6 baseline to now

### M8: Durability v2 (1.5 weeks)

**Goal:** kill a worker mid-run and nothing is lost.

- Leases and heartbeats so the system detects dead workers
- Resume: rebuild agent state from the event log, re-provision or restore the sandbox, continue
- Idempotent tool execution, deterministic replay for debugging
- Graceful shutdown, poison-job handling, dead-letter queue
- Concepts: durable execution, checkpoint vs event sourcing, exactly-once myths
- ADR: replay-from-log vs sandbox snapshots
- **Demo:** `kill -9` the worker mid-run, then the run finishes on another worker

### M8b (optional stretch): Port durability to Temporal or DBOS

- Re-implement the run lifecycle as a Temporal workflow (LLM call and tool executions as activities) or a DBOS durable function
- Write an ADR comparing it with our hand-built version: what it gives for free, what it costs, what we would pick in production
- **Why:** puts a hiring-keyword technology on the resume, and you can speak to it from first principles

### M9: Observability (1 week)

**Goal:** answer "why did this run fail or cost $4?" in 2 minutes.

- Structured logging, OpenTelemetry traces (run → step → model call/tool call)
- Token and cost accounting per run, per step, per model
- Metrics: queue depth, run duration, failure reasons
- LLM tracing UI (Langfuse or similar)
- **Demo:** trace view of a failed run showing the exact bad step

### M10: Security hardening (1–1.5 weeks)

**Goal:** a credible answer to "what if the repo is hostile?"

- Threat model document (STRIDE-lite): untrusted repo content, prompt injection, exfiltration, resource abuse, sandbox escape
- Network egress allowlist, secrets never in sandbox env, read-only mounts where possible, non-root, seccomp, optionally gVisor
- Command policy and dangerous-action detection
- Prompt-injection test suite (malicious README/issue text), added to the evals
- **Demo:** a repo with an injection payload fails to exfiltrate anything

### M11: Human in the loop (1 week)

**Goal:** agents you can trust, because you can stop them.

- Approval gates (configurable by tool/risk), pause and resume across worker restarts
- Mid-run user messages (steering), cancellation that actually stops containers
- Concepts: durable wait states, signals, UX of agent control
- **Demo:** the agent asks to run a risky command, you approve from the UI, and it continues

### M12: Web UI (1.5 weeks)

**Goal:** the thing recruiters will actually look at.

- Run list, live timeline (reasoning, tool calls, command output), diff viewer, cost/steps panel
- Submit-a-task flow, GitHub sign-in, run replay scrubber
- Records well on video: this drives the landing page demos
- **Demo:** polished end-to-end flow

### M13: Advanced agent and scale (2 weeks, pick a subset)

- Second provider (e.g. Claude) behind the existing `LLM` interface, compared against DeepSeek on the evals (pass rate vs cost)
- Planner and sub-agent pattern, or parallel exploration, judged by evals
- SWE-bench Verified subset run with published results (more credible than Lite; budget disk and time for its large per-repo Docker images)
- Rate limiting, concurrency limits, per-user quotas
- **Demo:** results page with real benchmark numbers

### M14: Ship it (1 week)

- Public deploy (the private M5 deploy, now opened up; safe only after M10 hardening and M13 per-user quotas), landing page with demo videos
- README with architecture diagram, "design decisions and tradeoffs", threat model, eval results
- Resume bullets with real numbers; interview notes finalized
- Final cleanup pass: tests, docs, license

**Total: roughly 15–18 weeks part-time.** Milestones M10–M13 are reorderable depending on what you want to emphasize.

---

## 6. Resume story this builds toward

- Designed a durable, event-sourced job system; runs survive worker crashes via leases and replay from an append-only log
- Built an isolated Docker sandbox with resource limits, network egress policy and a documented threat model
- Wrote an agent loop with context compaction and an editing/search toolset; improved eval pass rate from X% to Y% across N experiments, cutting cost per task by Z%
- Built an eval harness (N tasks, parallel runs, regression gate in CI); reported SWE-bench Verified subset results
- Instrumented with OpenTelemetry and LLM traces for per-run cost and latency attribution

(X comes from the M6 baseline; Y and Z from the M7 experiments onward.)

---

## 7. Rules to keep the project healthy

1. **Walking skeleton first, depth later.** Resist polishing a subsystem before it is connected end to end.
2. **Measure before improving.** From M6 on, agent changes need an eval run behind them. The harness comes before the agent improvements so the baseline exists.
3. **Every design choice gets a one-paragraph ADR.** This becomes your interview material and your README.
4. **Fake the edges in tests.** LLM and sandbox sit behind interfaces so the loop is testable without paying for tokens.
5. **Budget guard from day one.** A hard per-run step and cost cap (from M1) prevents surprise API bills.
6. **No scaffolding ahead of need.** No empty folders, placeholder files, stub packages, or unused config. A file or folder is created in the step that first needs it, and the target layout in section 3 is a destination, not a starting point.
7. **Secrets never cross into the sandbox.** Anything inside it is readable by the agent. Credentialed actions (push, PR) run in the worker.

---

## 8. Architecture and code conventions

Whenever we introduce a pattern, we state **the problem it solves and what the naive approach breaks**. If we cannot name the problem, we do not add the pattern (YAGNI; rule of three before abstracting).

**Architecture**

- **Ports and adapters.** Core logic (agent loop, run lifecycle) depends only on interfaces we own (`LLM`, `Sandbox`, `EventStore`, `Clock`). Real implementations (DeepSeek, Docker, Postgres) are adapters at the edge. Dependencies point inward. _Naive way breaks:_ the loop imports the SDK and Docker directly, so it cannot be tested without paying tokens and starting containers.
- **Dependency injection by plain function/constructor arguments.** No DI container.
- **Package boundaries enforced.** `agent` never imports `db` or `api`. Shared types live in `shared`.
- **Functional core, imperative shell.** Pure functions for decisions (budget checks, context compaction, state transitions); side effects at the edges.

**TypeScript**

- `strict`, `noUncheckedIndexedAccess`, no `any` (use `unknown` and narrow).
- Named exports only, no default exports. Kebab-case file names. Barrel files only at package entry points.
- Model states as discriminated unions (`RunState`, `AgentEvent`) so the compiler forces us to handle every case.

**Boundaries and errors**

- **Parse, don't validate:** Zod at every boundary (HTTP input, env, LLM tool arguments, DB JSON); derive TS types from the schemas.
- Expected failures (tool failed, command exited 1) are values (`Result`-style or events), not exceptions. Exceptions are for bugs and unrecoverable states.
- One typed, validated config module, loaded at startup, failing fast.

**Data**

- Schema changes only via Drizzle migrations, never by hand. `timestamptz` everywhere, sortable IDs (UUIDv7 via Postgres 18's native `uuidv7()`), constraints in the DB, not only in code.
- Event types are versioned from the start.

**Quality**

- Tests: many unit tests with fakes, some integration tests against real Postgres, few end-to-end.
- Structured logging (pino), no `console.log` in libraries. Every log line carries `runId`.
- Conventional Commits, small commits, one ADR per significant decision.
- `vp check` and tests must pass before each commit.
