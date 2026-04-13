import { ObjectId } from 'mongodb';
import pino from 'pino';

import { ClickUpTask, TimeInStatusResponse } from '@src/types/clickup';
import { TaskSnapshot } from '@src/types/db';
import { classify } from '@src/services/status/classifier';

const REWORK_FIELD_NAME = 'Rework Count';

/**
 * Extracts the numeric value of a custom field by name.
 * Returns the provided default if the field is absent or non-numeric.
 */
function extractCustomFieldNumber(
  task: ClickUpTask,
  fieldName: string,
  defaultValue: number,
): number {
  const field = task.custom_fields.find(
    (f) => f.name.toLowerCase() === fieldName.toLowerCase(),
  );
  if (!field || field.value == null) return defaultValue;
  const num = Number(field.value);
  return Number.isFinite(num) ? num : defaultValue;
}

/**
 * Builds a `time_in_status` record (status → milliseconds) from the
 * ClickUp TimeInStatusResponse. Minutes are converted to milliseconds.
 */
function buildTimeInStatus(
  tis: TimeInStatusResponse | undefined,
): Record<string, number> {
  if (!tis) return {};

  const result: Record<string, number> = {};

  if (tis.current_status) {
    result[tis.current_status.status] =
      tis.current_status.total_time.by_minute * 60_000;
  }

  if (tis.status_history) {
    for (const entry of tis.status_history) {
      result[entry.status] = entry.total_time.by_minute * 60_000;
    }
  }

  return result;
}

/**
 * Transforms a raw ClickUp task into a TaskSnapshot record.
 *
 * Requirements: 1.5, 13.1, 13.2, 13.3
 */
export function normalizeTask(
  task: ClickUpTask,
  timeInStatus?: TimeInStatusResponse,
  logger?: pino.Logger,
): Omit<TaskSnapshot, '_id'> {
  const assignee = task.assignees[0];

  return {
    clickup_task_id: task.id,
    name: task.name,
    description: task.description || undefined,
    status: task.status.status,
    normalized_status: classify(task.status.status, logger),
    priority: task.priority?.priority ?? 'none',
    assignee_id: assignee ? String(assignee.id) : '',
    assignee_name: assignee?.username ?? '',
    list_id: task.list.id,
    list_name: task.list.name,
    folder_name: task.folder.name,
    space_name: task.space.id,
    tags: task.tags.map((t) => t.name),
    story_points: task.points,
    rework_count: extractCustomFieldNumber(task, REWORK_FIELD_NAME, 0),
    time_estimated: task.time_estimate,
    time_logged: null,
    due_date: task.due_date ? new Date(Number(task.due_date)) : null,
    date_created: new Date(Number(task.date_created)),
    date_closed: task.date_closed
      ? new Date(Number(task.date_closed))
      : null,
    date_updated: new Date(Number(task.date_updated)),
    last_activity_date: new Date(Number(task.date_updated)),
    is_subtask: task.parent != null,
    parent_task_id: task.parent,
    time_in_status: buildTimeInStatus(timeInStatus),
    clickup_url: task.url,
    synced_at: new Date(),
  };
}

/**
 * Normalizes an array of ClickUp tasks into TaskSnapshot records.
 * Accepts an optional map of task ID → TimeInStatusResponse for enrichment.
 */
export function normalizeTasks(
  tasks: ClickUpTask[],
  timeInStatusMap?: Map<string, TimeInStatusResponse>,
  logger?: pino.Logger,
): Omit<TaskSnapshot, '_id'>[] {
  return tasks.map((task) =>
    normalizeTask(task, timeInStatusMap?.get(task.id), logger),
  );
}
