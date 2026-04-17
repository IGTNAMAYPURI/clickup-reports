/**
 * ClickUp API v2 client with rate limiting, concurrency control, and retry logic.
 *
 * - Tracks X-RateLimit-Remaining / X-RateLimit-Reset headers
 * - Pauses requests when remaining = 0 until reset time
 * - Limits to 5 concurrent requests via semaphore
 * - Retries 429 responses with exponential backoff + jitter (base 2s, max 5 retries)
 * - Retrieves API token from Secrets Manager and caches for invocation lifetime
 *
 * Requirements: 1.7, 1.8, 1.9, 22.1, 22.2, 22.3, 22.4
 */

import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import type { ClickUpTask, ClickUpMember, TimeInStatusResponse } from '@src/types/clickup';
import { withRetry } from '@src/utils/retry';
import { createLogger } from '@src/utils/logger';
import { getAwsClientConfig } from '@src/utils/aws-client.config';

const CLICKUP_BASE_URL = 'https://api.clickup.com/api/v2';
const MAX_CONCURRENCY = 5;
const RETRY_BASE_DELAY_MS = 2_000;
const RETRY_MAX_RETRIES = 5;
const RETRY_MAX_DELAY_MS = 64_000;

// ---------------------------------------------------------------------------
// Rate Limiter — tracks ClickUp rate-limit headers
// ---------------------------------------------------------------------------

export class RateLimiter {
  private remaining = Infinity;
  private resetAtMs = 0;

  /** Update state from response headers. */
  update(headers: Headers): void {
    const rem = headers.get('x-ratelimit-remaining');
    const reset = headers.get('x-ratelimit-reset');

    if (rem !== null) {
      this.remaining = parseInt(rem, 10);
    }
    if (reset !== null) {
      // ClickUp returns reset as epoch seconds
      this.resetAtMs = parseInt(reset, 10) * 1_000;
    }
  }

  /** Wait if remaining = 0 until the reset time has passed. */
  async waitIfNeeded(): Promise<void> {
    if (this.remaining > 0) return;

    const now = Date.now();
    if (this.resetAtMs > now) {
      const waitMs = this.resetAtMs - now;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    // After waiting, optimistically assume we have capacity again
    this.remaining = Infinity;
  }

  /** Expose state for testing. */
  getRemaining(): number {
    return this.remaining;
  }

  getResetAtMs(): number {
    return this.resetAtMs;
  }
}

// ---------------------------------------------------------------------------
// Semaphore — limits concurrent in-flight requests
// ---------------------------------------------------------------------------

export class Semaphore {
  private current = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.current++;
        resolve();
      });
    });
  }

  release(): void {
    this.current--;
    const next = this.queue.shift();
    if (next) next();
  }

  /** Expose state for testing. */
  getActive(): number {
    return this.current;
  }

  getQueueLength(): number {
    return this.queue.length;
  }
}

// ---------------------------------------------------------------------------
// Secrets cache — retrieves and caches the ClickUp API token
// ---------------------------------------------------------------------------

let cachedToken: string | null = null;

const secretsClient = new SecretsManagerClient(getAwsClientConfig());

export async function getClickUpToken(
  secretId: string = process.env.CLICKUP_SECRET_ID ?? 'clickup-api-token',
): Promise<string> {
  if (cachedToken) return cachedToken;

  const result = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: secretId }),
  );

  if (!result.SecretString) {
    throw new Error('ClickUp API token secret is empty');
  }

  cachedToken = result.SecretString;
  return cachedToken;
}

/** Reset cached token — useful for testing. */
export function resetTokenCache(): void {
  cachedToken = null;
}

// ---------------------------------------------------------------------------
// HTTP helper — single request with rate-limit tracking
// ---------------------------------------------------------------------------

export class ClickUpHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly url: string,
  ) {
    super(`ClickUp API ${status} ${statusText} for ${url}`);
    this.name = 'ClickUpHttpError';
  }
}

// ---------------------------------------------------------------------------
// ClickUp Client
// ---------------------------------------------------------------------------

export class ClickUpClient {
  private readonly rateLimiter = new RateLimiter();
  private readonly semaphore = new Semaphore(MAX_CONCURRENCY);
  private readonly logger = createLogger({
    correlationId: 'clickup-client',
    lambdaName: 'shared',
  });

  /**
   * Low-level fetch with semaphore, rate-limit wait, and header tracking.
   * Does NOT handle retries — that is the caller's responsibility.
   */
  private async request<T>(path: string, token: string): Promise<T> {
    await this.semaphore.acquire();
    try {
      await this.rateLimiter.waitIfNeeded();

      const url = `${CLICKUP_BASE_URL}${path}`;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: token,
          'Content-Type': 'application/json',
        },
      });

      this.rateLimiter.update(response.headers);

      if (!response.ok) {
        throw new ClickUpHttpError(response.status, response.statusText, url);
      }

      return (await response.json()) as T;
    } finally {
      this.semaphore.release();
    }
  }

  /**
   * Fetch with 429 retry (exponential backoff + jitter).
   * Only retries on 429 (rate limited) or 5xx (server error) responses.
   */
  private async requestWithRetry<T>(path: string, token: string): Promise<T> {
    return withRetry(
      () => this.request<T>(path, token),
      {
        maxRetries: RETRY_MAX_RETRIES,
        baseDelayMs: RETRY_BASE_DELAY_MS,
        maxDelayMs: RETRY_MAX_DELAY_MS,
        jitter: true,
      },
      (error) => {
        if (error instanceof ClickUpHttpError) {
          return error.status === 429 || error.status >= 500;
        }
        return true; // Retry network errors
      },
    );
  }

  /**
   * Fetch all tasks from a ClickUp list, handling pagination.
   * Optionally filters by `date_updated_gt` (epoch ms) for incremental sync.
   */
  async fetchTasks(
    listId: string,
    dateUpdatedGt?: number,
  ): Promise<ClickUpTask[]> {
    const token = await getClickUpToken();
    const allTasks: ClickUpTask[] = [];
    let page = 0;
    let hasMore = true;

    while (hasMore) {
      let path = `/list/${listId}/task?page=${page}&include_closed=true&subtasks=true`;
      if (dateUpdatedGt !== undefined) {
        path += `&date_updated_gt=${dateUpdatedGt}`;
      }

      const data = await this.requestWithRetry<{
        tasks: ClickUpTask[];
        last_page: boolean;
      }>(path, token);

      allTasks.push(...data.tasks);
      hasMore = !data.last_page;
      page++;
    }

    this.logger.info(
      { listId, taskCount: allTasks.length },
      'Fetched tasks from list',
    );
    return allTasks;
  }

  /**
   * Fetch subtasks for a given parent task.
   */
  async fetchSubtasks(taskId: string): Promise<ClickUpTask[]> {
    const token = await getClickUpToken();
    const data = await this.requestWithRetry<{ tasks: ClickUpTask[] }>(
      `/task/${taskId}?include_subtasks=true`,
      token,
    );
    return data.tasks ?? [];
  }

  /**
   * Fetch time-in-status data for a task.
   */
  async fetchTimeInStatus(taskId: string): Promise<TimeInStatusResponse> {
    const token = await getClickUpToken();
    return this.requestWithRetry<TimeInStatusResponse>(
      `/task/${taskId}/time_in_status`,
      token,
    );
  }

  /**
   * Fetch all members of a ClickUp team (workspace).
   */
  async fetchTeamMembers(teamId: string): Promise<ClickUpMember[]> {
    const token = await getClickUpToken();
    const data = await this.requestWithRetry<{ members: ClickUpMember[] }>(
      `/team/${teamId}/member`,
      token,
    );
    return data.members;
  }

  /** Expose internals for testing. */
  getRateLimiter(): RateLimiter {
    return this.rateLimiter;
  }

  getSemaphore(): Semaphore {
    return this.semaphore;
  }
}
