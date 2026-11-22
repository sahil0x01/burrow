// The life of a run:
//
//   queued ──► running ──► succeeded
//     │  ▲        │
//     │  └────────┤ (attempt crashed, retry later)
//     │           ├──────► failed
//     └───────────┴──────► cancelled
//
// A queued run can also fail (its last attempt crashed before it started) or be cancelled.
// Finished runs never change again.
export const runStatuses = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export type RunStatus = (typeof runStatuses)[number];

const allowed: Record<RunStatus, readonly RunStatus[]> = {
  queued: ["running", "failed", "cancelled"],
  running: ["queued", "succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return allowed[from].includes(to);
}

export function isFinished(status: RunStatus): boolean {
  return allowed[status].length === 0;
}
