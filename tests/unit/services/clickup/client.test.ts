import {
  RateLimiter,
  Semaphore,
  ClickUpClient,
  ClickUpHttpError,
  resetTokenCache,
} from '@src/services/clickup/client';

// ---------------------------------------------------------------------------
// Mock Secrets Manager
// ---------------------------------------------------------------------------
jest.mock('@aws-sdk/client-secrets-manager', () => {
  const send = jest.fn().mockResolvedValue({ SecretString: 'test-token' });
  return {
    SecretsManagerClient: jest.fn().mockImplementation(() => ({ send })),
    GetSecretValueCommand: jest.fn(),
  };
});

// ---------------------------------------------------------------------------
// Mock fetch globally
// ---------------------------------------------------------------------------
const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

beforeEach(() => {
  jest.clearAllMocks();
  resetTokenCache();
});

// ---------------------------------------------------------------------------
// RateLimiter
// ---------------------------------------------------------------------------
describe('RateLimiter', () => {
  it('should allow requests when remaining > 0', async () => {
    const rl = new RateLimiter();
    const headers = new Headers({
      'x-ratelimit-remaining': '50',
      'x-ratelimit-reset': '9999999999',
    });
    rl.update(headers);
    // Should resolve immediately
    await rl.waitIfNeeded();
    expect(rl.getRemaining()).toBe(50);
  });

  it('should wait when remaining = 0 and reset is in the future', async () => {
    jest.useFakeTimers();
    try {
      const rl = new RateLimiter();
      const now = Date.now();
      const resetEpochSec = Math.floor(now / 1000) + 2; // 2 seconds from now
      const headers = new Headers({
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(resetEpochSec),
      });
      rl.update(headers);

      let resolved = false;
      const promise = rl.waitIfNeeded().then(() => {
        resolved = true;
      });

      // Should not have resolved yet
      expect(resolved).toBe(false);

      // Advance timers past the reset time
      jest.advanceTimersByTime(2_500);
      await promise;

      expect(resolved).toBe(true);
      // After waiting, remaining resets to Infinity
      expect(rl.getRemaining()).toBe(Infinity);
    } finally {
      jest.useRealTimers();
    }
  });

  it('should not wait when remaining = 0 but reset is in the past', async () => {
    const rl = new RateLimiter();
    const resetEpochSec = Math.floor(Date.now() / 1000) - 10; // 10 seconds ago
    const headers = new Headers({
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(resetEpochSec),
    });
    rl.update(headers);

    const start = Date.now();
    await rl.waitIfNeeded();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(100);
  });

  it('should default to Infinity remaining when no headers present', async () => {
    const rl = new RateLimiter();
    expect(rl.getRemaining()).toBe(Infinity);
    await rl.waitIfNeeded(); // should not block
  });
});

// ---------------------------------------------------------------------------
// Semaphore
// ---------------------------------------------------------------------------
describe('Semaphore', () => {
  it('should allow up to max concurrent acquisitions', async () => {
    const sem = new Semaphore(3);
    await sem.acquire();
    await sem.acquire();
    await sem.acquire();
    expect(sem.getActive()).toBe(3);
    expect(sem.getQueueLength()).toBe(0);
  });

  it('should queue when max is reached and release unblocks', async () => {
    const sem = new Semaphore(2);
    await sem.acquire();
    await sem.acquire();

    let resolved = false;
    const pending = sem.acquire().then(() => {
      resolved = true;
    });

    // Should be queued
    expect(sem.getQueueLength()).toBe(1);
    expect(resolved).toBe(false);

    // Release one slot
    sem.release();
    await pending;
    expect(resolved).toBe(true);
    expect(sem.getActive()).toBe(2);
  });

  it('should process queue in FIFO order', async () => {
    const sem = new Semaphore(1);
    await sem.acquire();

    const order: number[] = [];
    const p1 = sem.acquire().then(() => order.push(1));
    const p2 = sem.acquire().then(() => order.push(2));

    sem.release();
    await p1;
    sem.release();
    await p2;

    expect(order).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------
// ClickUpClient
// ---------------------------------------------------------------------------
describe('ClickUpClient', () => {
  function mockResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      headers: new Headers({
        'x-ratelimit-remaining': '99',
        'x-ratelimit-reset': '9999999999',
        ...headers,
      }),
      json: jest.fn().mockResolvedValue(body),
    };
  }

  describe('fetchTasks', () => {
    it('should fetch all pages of tasks', async () => {
      const client = new ClickUpClient();

      mockFetch
        .mockResolvedValueOnce(
          mockResponse({ tasks: [{ id: '1' }], last_page: false }),
        )
        .mockResolvedValueOnce(
          mockResponse({ tasks: [{ id: '2' }], last_page: true }),
        );

      const tasks = await client.fetchTasks('list-1');
      expect(tasks).toHaveLength(2);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Verify pagination params
      const url0 = mockFetch.mock.calls[0][0] as string;
      expect(url0).toContain('page=0');
      const url1 = mockFetch.mock.calls[1][0] as string;
      expect(url1).toContain('page=1');
    });

    it('should pass date_updated_gt when provided', async () => {
      const client = new ClickUpClient();
      mockFetch.mockResolvedValueOnce(
        mockResponse({ tasks: [], last_page: true }),
      );

      await client.fetchTasks('list-1', 1700000000000);
      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('date_updated_gt=1700000000000');
    });
  });

  describe('fetchSubtasks', () => {
    it('should return subtasks array', async () => {
      const client = new ClickUpClient();
      mockFetch.mockResolvedValueOnce(
        mockResponse({ tasks: [{ id: 'sub-1' }, { id: 'sub-2' }] }),
      );

      const subtasks = await client.fetchSubtasks('task-1');
      expect(subtasks).toHaveLength(2);
    });

    it('should return empty array when no tasks field', async () => {
      const client = new ClickUpClient();
      mockFetch.mockResolvedValueOnce(mockResponse({}));

      const subtasks = await client.fetchSubtasks('task-1');
      expect(subtasks).toEqual([]);
    });
  });

  describe('fetchTimeInStatus', () => {
    it('should return time in status data', async () => {
      const client = new ClickUpClient();
      const body = {
        current_status: { status: 'open', total_time: { by_minute: 100 } },
        status_history: [],
      };
      mockFetch.mockResolvedValueOnce(mockResponse(body));

      const result = await client.fetchTimeInStatus('task-1');
      expect(result.current_status.status).toBe('open');
    });
  });

  describe('fetchTeamMembers', () => {
    it('should return team members', async () => {
      const client = new ClickUpClient();
      const body = {
        members: [{ user: { id: 1, username: 'dev1', email: 'dev1@test.com' } }],
      };
      mockFetch.mockResolvedValueOnce(mockResponse(body));

      const members = await client.fetchTeamMembers('team-1');
      expect(members).toHaveLength(1);
      expect(members[0].user.username).toBe('dev1');
    });
  });

  describe('error handling', () => {
    it('should throw ClickUpHttpError on non-OK response', async () => {
      const client = new ClickUpClient();
      mockFetch.mockResolvedValue(
        mockResponse({ err: 'not found' }, 404),
      );

      await expect(client.fetchTimeInStatus('bad-id')).rejects.toThrow(
        ClickUpHttpError,
      );
    });
  });
});
