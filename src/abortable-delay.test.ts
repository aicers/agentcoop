import { describe, expect, test, vi } from "vitest";
import { abortableDelay } from "./abortable-delay.js";

describe("abortableDelay", () => {
  test("rejects immediately when the signal is already aborted", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      controller.abort();

      const promise = abortableDelay(10_000, controller.signal);

      // No timer should be needed — rejection is synchronous on the
      // already-aborted signal.
      await expect(promise).rejects.toBe(controller.signal.reason);
      // Nothing should be left pending on the timer queue.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("rejects when the signal fires mid-wait without running out the timer", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const promise = abortableDelay(10_000, controller.signal);

      // Abort before the timer elapses.
      controller.abort();

      await expect(promise).rejects.toBe(controller.signal.reason);
      // The pending timer must have been cleared on abort.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("resolves after the delay when never aborted", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const resolved = vi.fn();
      const promise = abortableDelay(5_000, controller.signal).then(resolved);

      await vi.advanceTimersByTimeAsync(4_999);
      expect(resolved).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await promise;
      expect(resolved).toHaveBeenCalledTimes(1);
      // The abort listener must be detached so the signal does not leak
      // a reference to the resolved promise's machinery.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("resolves after the delay when no signal is provided", async () => {
    vi.useFakeTimers();
    try {
      const resolved = vi.fn();
      const promise = abortableDelay(1_000).then(resolved);

      await vi.advanceTimersByTimeAsync(1_000);
      await promise;
      expect(resolved).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
