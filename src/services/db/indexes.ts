/**
 * MongoDB index setup script.
 *
 * Creates all required indexes for the ClickUp reporting collections.
 * Safe to run multiple times — MongoDB's createIndex is idempotent.
 *
 * Req 14.1: Collection definitions
 * Req 14.2: Unique index on raw_tasks.clickup_task_id
 * Req 14.3: Unique index on developers.clickup_user_id
 */

import { Db } from 'mongodb';
import { createLogger } from '@src/utils/logger';

const logger = createLogger({
  correlationId: 'index-setup',
  lambdaName: 'shared-layer',
});

/**
 * Creates all required MongoDB indexes for the reporting system.
 * Idempotent — safe to call on every cold start or deployment.
 */
export async function ensureIndexes(db: Db): Promise<void> {
  logger.info('Creating MongoDB indexes');

  await Promise.all([
    // Unique index on raw_tasks.clickup_task_id
    db.collection('raw_tasks').createIndex(
      { clickup_task_id: 1 },
      { unique: true, name: 'idx_raw_tasks_clickup_task_id' },
    ),

    // Unique index on developers.clickup_user_id
    db.collection('developers').createIndex(
      { clickup_user_id: 1 },
      { unique: true, name: 'idx_developers_clickup_user_id' },
    ),

    // Unique index on sync_cursors.list_id
    db.collection('sync_cursors').createIndex(
      { list_id: 1 },
      { unique: true, name: 'idx_sync_cursors_list_id' },
    ),

    // Unique index on sla_config.key
    db.collection('sla_config').createIndex(
      { key: 1 },
      { unique: true, name: 'idx_sla_config_key' },
    ),

    // Compound unique index on report_snapshots.{report_type, period_start, team_id}
    db.collection('report_snapshots').createIndex(
      { report_type: 1, period_start: 1, team_id: 1 },
      { unique: true, name: 'idx_report_snapshots_type_period_team' },
    ),

    // Compound index on task_snapshots.{assignee_id, date_updated}
    db.collection('task_snapshots').createIndex(
      { assignee_id: 1, date_updated: 1 },
      { name: 'idx_task_snapshots_assignee_date_updated' },
    ),

    // Index on task_snapshots.{normalized_status}
    db.collection('task_snapshots').createIndex(
      { normalized_status: 1 },
      { name: 'idx_task_snapshots_normalized_status' },
    ),
  ]);

  logger.info('MongoDB indexes created successfully');
}
