import { describe, expect, it } from "vite-plus/test";
import { canTransition, isFinished, runStatuses } from "./run-status.ts";

describe("run status", () => {
  it("allows the normal life of a run", () => {
    expect(canTransition("queued", "running")).toBe(true);
    expect(canTransition("running", "queued")).toBe(true); // a crashed attempt, retried later
    expect(canTransition("running", "succeeded")).toBe(true);
    expect(canTransition("running", "cancelled")).toBe(true);
    expect(canTransition("queued", "cancelled")).toBe(true);
  });

  it("never lets a finished run change, or skip running on the way to success", () => {
    expect(canTransition("succeeded", "running")).toBe(false);
    expect(canTransition("cancelled", "running")).toBe(false);
    expect(canTransition("failed", "queued")).toBe(false);
    expect(canTransition("queued", "succeeded")).toBe(false);
  });

  it("knows which statuses are final", () => {
    expect(runStatuses.filter(isFinished)).toEqual(["succeeded", "failed", "cancelled"]);
  });
});
