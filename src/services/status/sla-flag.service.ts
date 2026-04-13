import { TaskSnapshot } from '@src/types/db';
import { AtRiskFlag, FlaggedTask, FlagSeverity } from '@src/types/report';
import { SlaThresholds } from '@src/config/config';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Severity ranking: red > orange > yellow */
const SEVERITY_MAP: Record<AtRiskFlag, FlagSeverity> = {
  overdue: 'red',
  inactive: 'orange',
  high_rework: 'orange',
  open_too_long: 'yellow',
};

const SEVERITY_RANK: Record<FlagSeverity, number> = {
  red: 3,
  orange: 2,
  yellow: 1,
};

/**
 * Returns the highest severity from a set of flags (Req 11.6).
 * red > orange > yellow
 */
export function getHighestSeverity(flags: AtRiskFlag[]): FlagSeverity {
  let highest: FlagSeverity = 'yellow';

  for (const flag of flags) {
    const severity = SEVERITY_MAP[flag];
    if (SEVERITY_RANK[severity] > SEVERITY_RANK[highest]) {
      highest = severity;
    }
  }

  return highest;
}

/**
 * Evaluates a single task against SLA rules and returns all matching flags.
 * Returns null if no flags apply.
 *
 * Rules (Req 11.1–11.5):
 *  - overdue 🔴: due_date < now AND status != closed_completed
 *  - inactive 🟠: (now - last_activity_date) >= inactivity_days
 *  - open_too_long 🟡: status != closed_completed AND (now - date_created) >= open_task_days
 *  - high_rework 🟠: rework_count >= rework_count_flag
 */
export function flagTask(
  task: TaskSnapshot,
  config: SlaThresholds,
  now: Date,
): FlaggedTask | null {
  const flags: AtRiskFlag[] = [];

  // Overdue: past due date and not closed (Req 11.1)
  if (
    task.due_date !== null &&
    task.due_date.getTime() < now.getTime() &&
    task.normalized_status !== 'closed_completed'
  ) {
    flags.push('overdue');
  }

  // Inactive: no activity for >= inactivity_days (Req 11.2)
  const daysSinceActivity = (now.getTime() - task.last_activity_date.getTime()) / MS_PER_DAY;
  if (daysSinceActivity >= config.inactivity_days) {
    flags.push('inactive');
  }

  // Open too long: non-closed and open >= open_task_days (Req 11.3)
  const daysOpen = (now.getTime() - task.date_created.getTime()) / MS_PER_DAY;
  if (task.normalized_status !== 'closed_completed' && daysOpen >= config.open_task_days) {
    flags.push('open_too_long');
  }

  // High rework: rework_count >= threshold (Req 11.4)
  if (task.rework_count >= config.rework_count_flag) {
    flags.push('high_rework');
  }

  if (flags.length === 0) {
    return null;
  }

  return {
    task,
    flags,
    highest_severity: getHighestSeverity(flags),
  };
}

/**
 * Evaluates all tasks and returns those with at least one flag (Req 11.5).
 */
export function flagTasks(
  tasks: TaskSnapshot[],
  config: SlaThresholds,
  now: Date,
): FlaggedTask[] {
  const results: FlaggedTask[] = [];

  for (const task of tasks) {
    const result = flagTask(task, config, now);
    if (result) {
      results.push(result);
    }
  }

  return results;
}
