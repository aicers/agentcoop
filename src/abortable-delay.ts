/**
 * Abort-aware delay helper shared by the CI polling and merge-readiness
 * retry loops.
 *
 * The polling/retry loops previously slept on a plain `setTimeout`, so a
 * Ctrl+C (which aborts the pipeline's `AbortSignal`) could not interrupt
 * a pending wait — cancellation was bounded by the full poll interval,
 * the poll timeout, or the CI verdict changing.  This helper rejects as
 * soon as the signal fires so the loop unwinds promptly.
 */

/**
 * Delay for `ms` milliseconds, rejecting early if `signal` aborts.
 *
 * Unlike a plain `setTimeout` wrapper, this rejects with the signal's
 * abort reason as soon as the provided signal fires instead of always
 * waiting the full duration.  Callers in the polling/retry loops let the
 * rejection propagate so the pipeline unwinds through its normal
 * cancelled path — the engine's `signal.aborted` check converts the
 * thrown abort into a cancelled result rather than a CI failure or
 * timeout.
 *
 * When no signal is supplied it behaves like a plain delay.  When the
 * signal is already aborted it rejects immediately without scheduling a
 * timer.
 */
export function abortableDelay(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    if (!signal) {
      setTimeout(resolve, ms);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
