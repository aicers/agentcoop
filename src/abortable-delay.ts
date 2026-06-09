/**
 * Abort-aware delay helper.
 *
 * Behaves like a plain `setTimeout`, resolving after `ms`, but if the
 * optional {@link AbortSignal} fires before the timer elapses it clears
 * the timer and *rejects* with the signal's abort reason instead of
 * waiting out the full duration.
 *
 * Rejection — rather than an early resolve — is deliberate.  A caller
 * that woke early and then fell through to its next poll or agent
 * invocation without re-checking the signal would reintroduce the very
 * unresponsiveness this guards against.  A thrown abort unwinds the
 * surrounding loop and the pipeline's existing post-handler
 * `signal.aborted` check turns it into the normal cancelled result, so
 * no new error type is needed.
 *
 * The signature is a superset of the plain `(ms) => Promise<void>` delay
 * the affected modules inject for testing, so existing injected delays
 * keep working unchanged — they simply ignore the extra argument.
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

    let onAbort: (() => void) | undefined;

    const timer = setTimeout(() => {
      if (signal && onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
      resolve();
    }, ms);

    if (signal) {
      onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
