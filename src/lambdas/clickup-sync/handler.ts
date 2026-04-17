/**
 * Sync Lambda handler — fetches incremental ClickUp task updates and persists
 * raw tasks + enriched task snapshots to MongoDB.
 *
 * Triggered every 30 minutes by EventBridge.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.10, 1.11, 18.2
 */

import { randomUUID } from 'crypto';
import {
  CloudWatchClient,
  PutMetricDataCommand,
} from '@aws-sdk/client-cloudwatch';
import { Db } from 'mongodb';

import { loadSpacesConfig, SpaceEntry } from '@src/config/config';
import { ClickUpClient } from '@src/services/clickup/client';
import { getDb } from '@src/services/db/connection';
import { normalizeTask } from '@src/services/sync/task-normalizer';
import { createLogger } from '@src/utils/logger';
import { getAwsClientConfig } from '@src/utils/aws-client.config';
import type { ClickUpTask } from '@src/types/clickup';
import type { SyncCursor } from '@src/types/db';

const NAMESPACE = 'ClickUpReporting';
const cloudwatch = new CloudWatchClient(getAwsClientConfig());

/**
 * Resolves the full set of list IDs to sync for a given space entry.
 * When `include_lists` is non-empty, only those lists are synced.
 * `exclude_lists` filters out specific lists.
 * When both are empty, the space_id itself is returned as a single-item
 * list — the caller should treat it as a list ID (spaces config is
 * expected to enumerate concrete list IDs in `include_lists`).
 */
function resolveListIds(space: SpaceEntry): string[] {
  const lists =
    space.include_lists.length > 0
      ? space.include_lists
      : [space.space_id]; // fallback: treat space_id as a list

  return lists.filter((id) => !space.exclude_lists.includes(id));
}

/**
 * Reads the sync cursor for a list from MongoDB.
 * Returns `null` when no cursor exists (first sync → full historical fetch).
 */
async function readSyncCursor(
  db: Db,
  listId: string,
): Promise<SyncCursor | null> {
  return db
    .collection<SyncCursor>('sync_cursors')
    .findOne({ list_id: listId });
}

/**
 * Upserts a raw task document keyed by `clickup_task_id`.
 */
async function upsertRawTask(
  db: Db,
  task: ClickUpTask,
  listId: string,
  spaceId: string,
): Promise<void> {
  const now = new Date();
  await db.collection('raw_tasks').updateOne(
    { clickup_task_id: task.id },
    {
      $set: {
        list_id: listId,
        space_id: spaceId,
        data: task as unknown as Record<string, unknown>,
        updated_at: now,
      },
      $setOnInsert: {
        fetched_at: now,
      },
    },
    { upsert: true },
  );
}

/**
 * Upserts a task snapshot document keyed by `clickup_task_id`.
 */
async function upsertTaskSnapshot(
  db: Db,
  snapshot: Record<string, unknown>,
): Promise<void> {
  await db.collection('task_snapshots').updateOne(
    { clickup_task_id: snapshot.clickup_task_id },
    { $set: snapshot },
    { upsert: true },
  );
}

/**
 * Updates (or creates) the sync cursor for a list after a successful fetch.
 */
async function updateSyncCursor(
  db: Db,
  listId: string,
  tasksFetched: number,
  status: 'success' | 'failed',
  errorMessage?: string,
): Promise<void> {
  const now = new Date();
  await db.collection<SyncCursor>('sync_cursors').updateOne(
    { list_id: listId },
    {
      $set: {
        last_synced_at: now,
        last_cursor_value: now.getTime(),
        tasks_fetched: tasksFetched,
        status,
        ...(errorMessage ? { error_message: errorMessage } : {}),
      },
    },
    { upsert: true },
  );
}


/**
 * Emits the TasksFetched CloudWatch metric.
 */
async function emitTasksFetchedMetric(count: number): Promise<void> {
  await cloudwatch.send(
    new PutMetricDataCommand({
      Namespace: NAMESPACE,
      MetricData: [
        {
          MetricName: 'TasksFetched',
          Value: count,
          Unit: 'Count',
          Timestamp: new Date(),
        },
      ],
    }),
  );
}

/**
 * Processes a single ClickUp list: fetch tasks (incremental or full),
 * fetch subtasks, upsert to MongoDB, and update the sync cursor.
 */
async function syncList(
  db: Db,
  client: ClickUpClient,
  listId: string,
  spaceId: string,
  logger: ReturnType<typeof createLogger>,
): Promise<number> {
  // 1. Read sync cursor
  const cursor = await readSyncCursor(db, listId);
  const dateUpdatedGt = cursor?.last_cursor_value; // undefined → full fetch

  logger.info(
    { listId, hasCursor: !!cursor, dateUpdatedGt },
    cursor
      ? 'Incremental sync from cursor'
      : 'No cursor found — performing full historical fetch',
  );

  // 2. Fetch tasks (paginated, with optional date_updated_gt filter)
  const tasks = await client.fetchTasks(listId, dateUpdatedGt);

  let totalProcessed = 0;

  for (const task of tasks) {
    // 3a. Upsert raw task
    await upsertRawTask(db, task, listId, spaceId);

    // 3b. Normalize and upsert task snapshot
    const snapshot = normalizeTask(task, undefined, logger);
    await upsertTaskSnapshot(db, snapshot as unknown as Record<string, unknown>);
    totalProcessed++;

    // 3c. Fetch and process subtasks independently (Req 1.6, 13.1)
    if (task.subtasks && task.subtasks.length > 0) {
      for (const subtask of task.subtasks) {
        await upsertRawTask(db, subtask, listId, spaceId);
        const subSnapshot = normalizeTask(subtask, undefined, logger);
        await upsertTaskSnapshot(
          db,
          subSnapshot as unknown as Record<string, unknown>,
        );
        totalProcessed++;
      }
    } else {
      // Attempt to fetch subtasks via API if not embedded
      try {
        const subtasks = await client.fetchSubtasks(task.id);
        for (const subtask of subtasks) {
          await upsertRawTask(db, subtask, listId, spaceId);
          const subSnapshot = normalizeTask(subtask, undefined, logger);
          await upsertTaskSnapshot(
            db,
            subSnapshot as unknown as Record<string, unknown>,
          );
          totalProcessed++;
        }
      } catch (subtaskError) {
        logger.warn(
          { taskId: task.id, err: subtaskError },
          'Failed to fetch subtasks for task — continuing',
        );
      }
    }
  }

  // 4. Update sync cursor on success
  await updateSyncCursor(db, listId, totalProcessed, 'success');

  logger.info(
    { listId, tasksProcessed: totalProcessed },
    'List sync completed',
  );

  return totalProcessed;
}

/**
 * Lambda handler entry point.
 * Triggered by EventBridge every 30 minutes.
 */
export const handler = async (_event: unknown): Promise<void> => {
  const correlationId = randomUUID();
  const logger = createLogger({ correlationId, lambdaName: 'clickup-sync' });

  logger.info({ correlationId }, 'Sync Lambda invoked');

  const db = await getDb();
  const client = new ClickUpClient();
  const config = loadSpacesConfig();

  let totalTasksFetched = 0;
  const failedLists: string[] = [];

  for (const space of config.spaces) {
    const listIds = resolveListIds(space);

    for (const listId of listIds) {
      try {
        const count = await syncList(
          db,
          client,
          listId,
          space.space_id,
          logger,
        );
        totalTasksFetched += count;
      } catch (error) {
        // Req 1.10: Log failure per list and continue processing remaining lists
        logger.error(
          { listId, spaceId: space.space_id, err: error },
          'Failed to sync list — continuing with remaining lists',
        );
        failedLists.push(listId);
      }
    }
  }

  // Emit CloudWatch metric (Req 18.2)
  try {
    await emitTasksFetchedMetric(totalTasksFetched);
  } catch (metricError) {
    logger.warn({ err: metricError }, 'Failed to emit TasksFetched metric');
  }

  logger.info(
    {
      correlationId,
      totalTasksFetched,
      failedLists,
      failedCount: failedLists.length,
    },
    'Sync Lambda completed',
  );
};
