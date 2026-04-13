/**
 * Retry utility with exponential backoff and optional jitter.
 * Used by ClickUp Client (429 retries) and Sheets Client.
 *
 * Delay formula: min(baseDelayMs * 2^(attempt-1), maxDelayMs)
 * Jitter: ±50% of computed delay when enabled.
 */

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  jitter?: boolean;
}

/**
 * Computes the delay for a given retry attempt.
 * Exported for testability (property tests validate delay bounds).
 */
export function computeDelay(
  attempt: number,
  options: RetryOptions,
  random: number = Math.random(),
): number {
  const exponentialDelay = options.baseDelayMs * Math.pow(2, attempt - 1);
  const capped =
    options.maxDelayMs !== undefined
      ? Math.min(exponentialDelay, options.maxDelayMs)
      : exponentialDelay;

  if (options.jitter) {
    // jitter range: [0.5 * capped, 1.5 * capped]
    const jitterFactor = 0.5 + random; // random in [0,1) → factor in [0.5, 1.5)
    return Math.floor(capped * jitterFactor);
  }

  return capped;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retries `fn` up to `maxRetries` times with exponential backoff.
 * Throws the last error after all retries are exhausted.
 *
 * @param shouldRetry Optional predicate — when provided, only errors for which
 *   it returns `true` are retried. Non-retryable errors are thrown immediately.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
  shouldRetry?: (error: unknown) => boolean,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (shouldRetry && !shouldRetry(error)) {
        throw error;
      }

      if (attempt < options.maxRetries) {
        const delay = computeDelay(attempt + 1, options);
        await sleep(delay);
      }
    }
  }

  throw lastError;
}
