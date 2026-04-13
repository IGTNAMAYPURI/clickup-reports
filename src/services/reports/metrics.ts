import { TaskSnapshot } from '@src/types/db';
import { DeveloperKPIs, TeamKPIs } from '@src/types/report';
import { SlaThresholds } from '@src/config/config';
import { flagTasks } from '@src/services/status/sla-flag.service';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Computes the completion rate: closed / total.
 * Returns 0 when there are no tasks.
 */
export function computeCompletionRate(tasks: TaskSnapshot[]): number {
  if (tasks.length === 0) return 0;
  const closed = tasks.filter((t) => t.normalized_status === 'closed_completed').length;
  return closed / tasks.length;
}

/**
 * Computes the average age in days for non-closed tasks.
 * Age = (periodEnd - date_created) / MS_PER_DAY.
 * Returns 0 when there are no non-closed tasks.
 */
export function computeAverageTaskAge(tasks: TaskSnapshot[], periodEnd: Date): number {
  const nonClosed = tasks.filter((t) => t.normalized_status !== 'closed_completed');
  if (nonClosed.length === 0) return 0;

  const totalDays = nonClosed.reduce((sum, t) => {
    const ageDays = (periodEnd.getTime() - t.date_created.getTime()) / MS_PER_DAY;
    return sum + Math.max(0, ageDays);
  }, 0);

  return totalDays / nonClosed.length;
}

/**
 * Computes the average time (ms) tasks have spent in a given status key.
 * Uses the `time_in_status` map on each task.
 * Returns 0 when no tasks have time recorded for that status.
 */
export function computeAverageTimeInStatus(tasks: TaskSnapshot[], status: string): number {
  const withTime = tasks.filter((t) => t.time_in_status[status] != null && t.time_in_status[status] > 0);
  if (withTime.length === 0) return 0;

  const total = withTime.reduce((sum, t) => sum + (t.time_in_status[status] ?? 0), 0);
  return total / withTime.length;
}

/**
 * Computes velocity delta as a percentage change vs the prior period's tasks_closed.
 * Returns null when priorClosed is 0 (cannot compute % change from zero).
 */
export function computeVelocityDelta(currentClosed: number, priorClosed: number): number | null {
  if (priorClosed === 0) return null;
  return ((currentClosed - priorClosed) / priorClosed) * 100;
}

/**
 * Computes all 17 developer KPIs from a set of task snapshots.
 *
 * @param tasks       - Tasks assigned to the developer within the current period
 * @param priorTasks  - Tasks assigned to the developer within the prior equivalent period
 * @param periodEnd   - End date of the current reporting period
 * @param slaConfig   - SLA thresholds for at-risk flagging
 * @param reworkThreshold - Threshold for high-rework task count (default from slaConfig)
 *
 * Requirements: 7.1, 8.1
 */
export function computeKPIs(
  tasks: TaskSnapshot[],
  priorTasks: TaskSnapshot[],
  periodEnd: Date,
  slaConfig: SlaThresholds,
): DeveloperKPIs {
  // 1. tasks_closed: count of tasks with normalized_status = closed_completed
  const closedTasks = tasks.filter((t) => t.normalized_status === 'closed_completed');
  const tasks_closed = closedTasks.length;

  // 2. tasks_in_progress: count of tasks with normalized_status = active
  const tasks_in_progress = tasks.filter((t) => t.normalized_status === 'active').length;

  // 3. tasks_in_qa: count of tasks with normalized_status = done_in_qa
  const tasks_in_qa = tasks.filter((t) => t.normalized_status === 'done_in_qa').length;

  // 4. tasks_opened: count of tasks created in the period
  //    All tasks in the set are assumed to be within the period scope
  const tasks_opened = tasks.length;

  // 5. subtasks_closed: count of closed tasks where is_subtask = true
  const subtasks_closed = closedTasks.filter((t) => t.is_subtask).length;

  // 6. overdue_tasks: count of tasks with due_date < period_end and not closed
  const overdue_tasks = tasks.filter(
    (t) =>
      t.due_date !== null &&
      t.due_date.getTime() < periodEnd.getTime() &&
      t.normalized_status !== 'closed_completed',
  ).length;

  // 7. at_risk_tasks: count of tasks flagged by SLA rules
  const flaggedTasks = flagTasks(tasks, slaConfig, periodEnd);
  const at_risk_tasks = flaggedTasks.length;

  // 8. story_points_completed: sum of story_points for closed tasks
  const story_points_completed = closedTasks.reduce((sum, t) => sum + (t.story_points ?? 0), 0);

  // 9. time_logged_ms: sum of time_logged for all tasks
  const time_logged_ms = tasks.reduce((sum, t) => sum + (t.time_logged ?? 0), 0);

  // 10. estimated_vs_logged_ratio: time_estimated / time_logged (null when time_logged = 0)
  const total_estimated = tasks.reduce((sum, t) => sum + (t.time_estimated ?? 0), 0);
  const estimated_vs_logged_ratio = time_logged_ms === 0 ? null : total_estimated / time_logged_ms;

  // 11. completion_rate: closed / total (0 to 1)
  const completion_rate = computeCompletionRate(tasks);

  // 12. average_task_age_days: avg days open for non-closed tasks
  const average_task_age_days = computeAverageTaskAge(tasks, periodEnd);

  // 13. average_time_in_pr_ms: avg time in "PULL REQUEST" status
  const average_time_in_pr_ms = computeAverageTimeInStatus(tasks, 'PULL REQUEST');

  // 14. average_time_in_qa_ms: avg time in "TESTING" status
  const average_time_in_qa_ms = computeAverageTimeInStatus(tasks, 'TESTING');

  // 15. total_rework_count: sum of rework_count across all tasks
  const total_rework_count = tasks.reduce((sum, t) => sum + t.rework_count, 0);

  // 16. high_rework_task_count: count of tasks with rework_count >= threshold (default 2)
  const high_rework_task_count = tasks.filter(
    (t) => t.rework_count >= slaConfig.rework_count_flag,
  ).length;

  // 17. velocity_delta: % change vs prior period's tasks_closed (null when prior = 0)
  const priorClosed = priorTasks.filter((t) => t.normalized_status === 'closed_completed').length;
  const velocity_delta = computeVelocityDelta(tasks_closed, priorClosed);

  return {
    tasks_closed,
    tasks_in_progress,
    tasks_in_qa,
    tasks_opened,
    subtasks_closed,
    overdue_tasks,
    at_risk_tasks,
    story_points_completed,
    time_logged_ms,
    estimated_vs_logged_ratio,
    completion_rate,
    average_task_age_days,
    average_time_in_pr_ms,
    average_time_in_qa_ms,
    total_rework_count,
    high_rework_task_count,
    velocity_delta,
  };
}

/**
 * Aggregates an array of DeveloperKPIs into a single TeamKPIs object.
 *
 * Most metrics are summed across developers.
 * completion_rate = total_closed / total_tasks across all devs.
 * estimated_vs_logged_ratio = total_estimated / total_logged across all devs (null when total_logged = 0).
 * average_task_age_days = weighted average (not sum).
 * average_time_in_pr_ms = weighted average (not sum).
 * average_time_in_qa_ms = weighted average (not sum).
 * velocity_delta = null (recomputed at team level by caller if needed, or summed).
 *
 * Requirements: 8.1
 */
export function computeTeamKPIs(
  devKPIs: DeveloperKPIs[],
  allTasks: TaskSnapshot[],
  priorTasks: TaskSnapshot[],
  periodEnd: Date,
  slaConfig: SlaThresholds,
): TeamKPIs {
  if (devKPIs.length === 0) {
    return {
      tasks_closed: 0,
      tasks_in_progress: 0,
      tasks_in_qa: 0,
      tasks_opened: 0,
      subtasks_closed: 0,
      overdue_tasks: 0,
      at_risk_tasks: 0,
      story_points_completed: 0,
      time_logged_ms: 0,
      estimated_vs_logged_ratio: null,
      completion_rate: 0,
      average_task_age_days: 0,
      average_time_in_pr_ms: 0,
      average_time_in_qa_ms: 0,
      total_rework_count: 0,
      high_rework_task_count: 0,
      velocity_delta: null,
    };
  }

  const sum = (fn: (k: DeveloperKPIs) => number) => devKPIs.reduce((acc, k) => acc + fn(k), 0);

  const tasks_closed = sum((k) => k.tasks_closed);
  const tasks_in_progress = sum((k) => k.tasks_in_progress);
  const tasks_in_qa = sum((k) => k.tasks_in_qa);
  const tasks_opened = sum((k) => k.tasks_opened);
  const subtasks_closed = sum((k) => k.subtasks_closed);
  const overdue_tasks = sum((k) => k.overdue_tasks);
  const at_risk_tasks = sum((k) => k.at_risk_tasks);
  const story_points_completed = sum((k) => k.story_points_completed);
  const time_logged_ms = sum((k) => k.time_logged_ms);
  const total_rework_count = sum((k) => k.total_rework_count);
  const high_rework_task_count = sum((k) => k.high_rework_task_count);

  // completion_rate = total_closed / total_tasks across all devs
  const totalTasks = sum((k) => k.tasks_opened);
  const completion_rate = totalTasks === 0 ? 0 : tasks_closed / totalTasks;

  // estimated_vs_logged_ratio: compute from all tasks rather than averaging ratios
  const totalEstimated = allTasks.reduce((s, t) => s + (t.time_estimated ?? 0), 0);
  const totalLogged = allTasks.reduce((s, t) => s + (t.time_logged ?? 0), 0);
  const estimated_vs_logged_ratio = totalLogged === 0 ? null : totalEstimated / totalLogged;

  // average_task_age_days: compute from all tasks directly
  const average_task_age_days = computeAverageTaskAge(allTasks, periodEnd);

  // average_time_in_pr_ms: compute from all tasks directly
  const average_time_in_pr_ms = computeAverageTimeInStatus(allTasks, 'PULL REQUEST');

  // average_time_in_qa_ms: compute from all tasks directly
  const average_time_in_qa_ms = computeAverageTimeInStatus(allTasks, 'TESTING');

  // velocity_delta: % change of team tasks_closed vs prior period
  const priorClosed = priorTasks.filter((t) => t.normalized_status === 'closed_completed').length;
  const velocity_delta = computeVelocityDelta(tasks_closed, priorClosed);

  return {
    tasks_closed,
    tasks_in_progress,
    tasks_in_qa,
    tasks_opened,
    subtasks_closed,
    overdue_tasks,
    at_risk_tasks,
    story_points_completed,
    time_logged_ms,
    estimated_vs_logged_ratio,
    completion_rate,
    average_task_age_days,
    average_time_in_pr_ms,
    average_time_in_qa_ms,
    total_rework_count,
    high_rework_task_count,
    velocity_delta,
  };
}
