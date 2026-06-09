import { describe, expect, test } from "vitest";
import { abortableDelay } from "./abortable-delay.js";

describe("abortableDelay", () => {
  test("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    // A 10-minute timer would never fire within the test, so resolving
    // here proves the already-aborted fast path skips the timer entirely.
    await expect(abortableDelay(600_000, controller.signal)).rejects.toThrow();
  });

  test("rejects as soon as the signal aborts mid-wait", async () => {
    const controller = new AbortController();
    const promise = abortableDelay(600_000, controller.signal);
    controller.abort();
    await expect(promise).rejects.toThrow();
  });

  test("rejects with the signal's abort reason", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    const promise = abortableDelay(600_000, controller.signal);
    controller.abort(reason);
    await expect(promise).rejects.toBe(reason);
  });

  test("resolves after the delay when no signal is provided", async () => {
    await expect(abortableDelay(0)).resolves.toBeUndefined();
  });

  test("resolves after the delay when the signal never aborts", async () => {
    const controller = new AbortController();
    await expect(abortableDelay(0, controller.signal)).resolves.toBeUndefined();
  });
});
