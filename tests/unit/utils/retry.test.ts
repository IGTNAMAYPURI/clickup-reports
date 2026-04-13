import { withRetry, computeDelay, RetryOptions } from '@src/utils/retry';

describe('computeDelay', () => {
  const baseOptions: RetryOptions = {
    maxRetries: 5,
    baseDelayMs: 2000,
  };

  it('should compute exponential delay without jitter', () => {
    expect(computeDelay(1, baseOptions)).toBe(2000);
    expect(computeDelay(2, baseOptions)).toBe(4000);
    expect(computeDelay(3, baseOptions)).toBe(8000);
    expect(computeDelay(4, baseOptions)).toBe(16000);
    expect(computeDelay(5, baseOptions)).toBe(32000);
  });

  it('should cap delay at maxDelayMs', () => {
    const opts: RetryOptions = { ...baseOptions, maxDelayMs: 10000 };
    expect(computeDelay(1, opts)).toBe(2000);
    expect(computeDelay(3, opts)).toBe(8000);
    expect(computeDelay(4, opts)).toBe(10000); // capped
    expect(computeDelay(5, opts)).toBe(10000); // capped
  });

  it('should apply jitter within ±50% range', () => {
    const opts: RetryOptions = { ...baseOptions, jitter: true };
    // random=0 → factor=0.5 → delay = 2000*0.5 = 1000
    expect(computeDelay(1, opts, 0)).toBe(1000);
    // random=0.5 → factor=1.0 → delay = 2000
    expect(computeDelay(1, opts, 0.5)).toBe(2000);
    // random=0.999 → factor=1.499 → delay ≈ 2998
    expect(computeDelay(1, opts, 0.999)).toBe(2998);
  });

  it('should apply jitter after capping at maxDelayMs', () => {
    const opts: RetryOptions = {
      ...baseOptions,
      maxDelayMs: 10000,
      jitter: true,
    };
    // attempt 5: exponential=32000, capped=10000, random=0.5 → 10000
    expect(computeDelay(5, opts, 0.5)).toBe(10000);
    // attempt 5: capped=10000, random=0 → 5000
    expect(computeDelay(5, opts, 0)).toBe(5000);
  });
});

describe('withRetry', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const fastOptions: RetryOptions = {
    maxRetries: 3,
    baseDelayMs: 10,
    jitter: false,
  };

  it('should return result on first success', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, fastOptions);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should retry and succeed on later attempt', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockResolvedValue('ok');

    const promise = withRetry(fn, fastOptions);

    // Advance timers for each retry delay
    await jest.advanceTimersByTimeAsync(10); // retry 1 delay
    await jest.advanceTimersByTimeAsync(20); // retry 2 delay

    const result = await promise;
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('should throw last error after maxRetries exhausted', async () => {
    jest.useRealTimers();
    const realFastOptions: RetryOptions = {
      maxRetries: 2,
      baseDelayMs: 1,
      jitter: false,
    };
    const fn = jest.fn().mockRejectedValue(new Error('always fails'));

    await expect(withRetry(fn, realFastOptions)).rejects.toThrow(
      'always fails',
    );
    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it('should work with zero maxRetries (no retries)', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('no retry'));
    const opts: RetryOptions = { maxRetries: 0, baseDelayMs: 10 };

    await expect(withRetry(fn, opts)).rejects.toThrow('no retry');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should work with generic types', async () => {
    const fn = jest.fn().mockResolvedValue({ id: 1, name: 'test' });
    const result = await withRetry<{ id: number; name: string }>(
      fn,
      fastOptions,
    );
    expect(result).toEqual({ id: 1, name: 'test' });
  });
});
