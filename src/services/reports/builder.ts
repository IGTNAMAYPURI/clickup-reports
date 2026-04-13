import { Developer, TaskSnapshot, Team } from '@src/types/db';
import {
  AtRiskFlag,
  BottleneckEntry,
  DeveloperComparisonRow,
  DeveloperKPIs,
  DeveloperReport,
  FlaggedTask,
  ReportPeriod,
  ReworkAnalysis,
  StatusFlowEntry,
  TaskBreakdownRow,
  TeamKPIs,
  TeamReport,
  TrendComparison,
  WorkloadEntry,
} from '@src/types/report';
import { SlaThresholds } from '@src/config/config';
import { computeKPIs, computeTeamKPIs } from '@src/services/reports/metrics';
import { flagTask, flagTasks } from '@src/services/status/sla-flag.service';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Builds a TaskBreakdownRow from a TaskSnapshot.
 * Req 7.2: All 19 fields populated.
 */
function buildTaskBreakdownRow(
  task: TaskSnapshot,
  periodEnd: Date,
  slaConfig: SlaThresholds,
): TaskBreakdownRow {
  const flagResult = flagTask(task, slaConfig, periodEnd);
  const atRiskFlag: AtRiskFlag | null =
    flagResult && flagResult.flags.length > 0 ? flagResult.flags[0] : null;

  // days_open = difference between date_created and earlier of date_closed or periodEnd
  const endDate = task.date_closed && task.date_closed.getTime() < periodEnd.getTime()
    ? task.date_closed
    : periodEnd;
  const daysOpen = Math.max(0, Math.floor((endDate.getTime() - task.date_created.getTime()) / MS_PER_DAY));

  // on_time: true if closed <= due, false if closed > due, null if either missing
  let onTime: boolean | null = null;
  if (task.date_closed !== null && task.due_date !== null) {
    onTime = task.date_closed.getTime() <= task.due_date.getTime();
  }

  return {
    task_id: task.clickup_task_id,
    task_name: task.name,
    parent_task_id: task.parent_task_id,
    is_subtask: task.is_subtask,
    list_folder: `${task.list_name}/${task.folder_name}`,
    status: task.status,
    priority: task.priority,
    story_points: task.story_points,
    rework_count: task.rework_count,
    time_estimated_ms: task.time_estimated,
    time_logged_ms: task.time_logged,
    due_date: task.due_date,
    date_closed: task.date_closed,
    on_time: onTime,
    days_open: daysOpen,
    last_activity: task.last_activity_date,
    at_risk_flag: atRiskFlag,
    tags: task.tags,
    clickup_url: task.clickup_url,
  };
}

/**
 * Builds StatusFlowEntry[] from tasks' time_in_status maps.
 * Req 7.3: Time spent in each status for each task.
 */
function buildStatusFlow(tasks: TaskSnapshot[]): StatusFlowEntry[] {
  return tasks.map((task) => ({
    task_id: task.clickup_task_id,
    task_name: task.name,
    status_durations: { ...task.time_in_status },
  }));
}

/**
 * Builds priority distribution: Record<string, number>.
 * Req 7.4: Sum of values equals total task count.
 */
function buildPriorityDistribution(tasks: TaskSnapshot[]): Record<string, number> {
  const dist: Record<string, number> = {};
  for (const task of tasks) {
    const key = task.priority || 'none';
    dist[key] = (dist[key] ?? 0) + 1;
  }
  return dist;
}

/**
 * Builds ReworkAnalysis from tasks.
 * Req 7.5: total_rework_count, flagged_tasks (>= threshold), top 5 by rework_count desc.
 */
function buildReworkAnalysis(tasks: TaskSnapshot[], reworkThreshold: number): ReworkAnalysis {
  const total_rework_count = tasks.reduce((sum, t) => sum + t.rework_count, 0);

  const flagged = tasks.filter((t) => t.rework_count >= reworkThreshold);
  // Sort descending by rework_count for top 5
  const sorted = [...flagged].sort((a, b) => b.rework_count - a.rework_count);
  const top_5_reworked = sorted.slice(0, 5);

  return {
    total_rework_count,
    flagged_tasks: flagged,
    top_5_reworked,
  };
}

/**
 * Computes trend deltas between current and prior KPIs.
 * Req 7.6, 8.6: delta = (current - prior) / prior * 100, null when prior = 0.
 */
function computeTrendDeltas(
  current: DeveloperKPIs | TeamKPIs,
  prior: DeveloperKPIs | TeamKPIs,
): Record<string, number | null> {
  const deltas: Record<string, number | null> = {};
  const currentRec = current as unknown as Record<string, unknown>;
  const priorRec = prior as unknown as Record<string, unknown>;

  const numericKeys = Object.keys(current).filter(
    (k) => typeof currentRec[k] === 'number',
  );

  for (const key of numericKeys) {
    const curr = currentRec[key] as number;
    const prev = priorRec[key] as number;

    if (prev === 0) {
      deltas[key] = null;
    } else {
      deltas[key] = ((curr - prev) / prev) * 100;
    }
  }

  return deltas;
}

/**
 * Builds a complete DeveloperReport.
 *
 * Req 7.1–7.7: KPIs, task breakdown, status flow, priority distribution,
 * rework analysis, trend comparison, at-risk tasks.
 */
export function buildDeveloperReport(
  developer: Developer,
  tasks: TaskSnapshot[],
  period: ReportPeriod,
  priorTasks: TaskSnapshot[],
  slaConfig: SlaThresholds,
): DeveloperReport {
  const periodEnd = period.end;

  // 1. Compute KPIs (Req 7.1)
  const kpis = computeKPIs(tasks, priorTasks, periodEnd, slaConfig);

  // 2. Compute prior KPIs for trend comparison
  const priorKpis = computeKPIs(priorTasks, [], periodEnd, slaConfig);

  // 3. Task breakdown rows (Req 7.2)
  const task_breakdown = tasks.map((t) => buildTaskBreakdownRow(t, periodEnd, slaConfig));

  // 4. Status flow (Req 7.3)
  const status_flow = buildStatusFlow(tasks);

  // 5. Priority distribution (Req 7.4)
  const priority_distribution = buildPriorityDistribution(tasks);

  // 6. Rework analysis (Req 7.5)
  const rework_analysis = buildReworkAnalysis(tasks, slaConfig.rework_count_flag);

  // 7. Trend comparison (Req 7.6)
  const trend_comparison: TrendComparison = {
    current: kpis,
    prior: priorKpis,
    deltas: computeTrendDeltas(kpis, priorKpis),
  };

  // 8. At-risk tasks (Req 7.7)
  const at_risk_tasks = flagTasks(tasks, slaConfig, periodEnd);

  return {
    developer,
    period,
    kpis,
    task_breakdown,
    status_flow,
    priority_distribution,
    rework_analysis,
    trend_comparison,
    at_risk_tasks,
  };
}

/**
 * Builds bottleneck analysis: percentage of tasks in each normalized status.
 * Req 8.4: Percentages sum to 100%.
 */
function buildBottleneckAnalysis(tasks: TaskSnapshot[]): BottleneckEntry[] {
  if (tasks.length === 0) return [];

  const statusCounts: Record<string, { count: number; totalTimeMs: number }> = {};

  for (const task of tasks) {
    const status = task.normalized_status;
    if (!statusCounts[status]) {
      statusCounts[status] = { count: 0, totalTimeMs: 0 };
    }
    statusCounts[status].count += 1;

    // Sum time_in_status for the normalized status key
    const timeInThisStatus = task.time_in_status[task.status] ?? 0;
    statusCounts[status].totalTimeMs += timeInThisStatus;
  }

  const total = tasks.length;

  return Object.entries(statusCounts).map(([status, { count, totalTimeMs }]) => ({
    status,
    task_count: count,
    percentage: (count / total) * 100,
    average_time_ms: count > 0 ? totalTimeMs / count : 0,
  }));
}

/**
 * Builds workload distribution entries with 35% flagging.
 * Req 8.7: Flag developers exceeding threshold % of any team metric.
 */
function buildWorkloadDistribution(
  devReports: DeveloperReport[],
  threshold: number,
): { entries: WorkloadEntry[]; flags: string[] } {
  const flaggedDevIds = new Set<string>();
  const entries: WorkloadEntry[] = [];

  const metrics: { name: string; getValue: (k: DeveloperKPIs) => number }[] = [
    { name: 'tasks_closed', getValue: (k) => k.tasks_closed },
    { name: 'tasks_in_progress', getValue: (k) => k.tasks_in_progress },
    { name: 'story_points_completed', getValue: (k) => k.story_points_completed },
    { name: 'time_logged_ms', getValue: (k) => k.time_logged_ms },
    { name: 'total_rework_count', getValue: (k) => k.total_rework_count },
  ];

  for (const metric of metrics) {
    const teamTotal = devReports.reduce((sum, r) => sum + metric.getValue(r.kpis), 0);

    for (const report of devReports) {
      const value = metric.getValue(report.kpis);
      const pct = teamTotal === 0 ? 0 : (value / teamTotal) * 100;
      const flagged = teamTotal > 0 && pct > threshold;

      if (flagged) {
        flaggedDevIds.add(report.developer.clickup_user_id);
      }

      entries.push({
        developer_id: report.developer.clickup_user_id,
        developer_name: `${report.developer.first_name} ${report.developer.last_name}`,
        metric_name: metric.name,
        value,
        percentage_of_team: pct,
        flagged,
      });
    }
  }

  return { entries, flags: Array.from(flaggedDevIds) };
}

/**
 * Builds a full team task list from developer reports, deduplicating by task_id.
 * Req 8.3: Union without duplicates.
 */
function buildFullTaskList(devReports: DeveloperReport[]): TaskBreakdownRow[] {
  const seen = new Set<string>();
  const result: TaskBreakdownRow[] = [];

  for (const report of devReports) {
    for (const row of report.task_breakdown) {
      if (!seen.has(row.task_id)) {
        seen.add(row.task_id);
        result.push(row);
      }
    }
  }

  return result;
}

/**
 * Builds a complete TeamReport.
 *
 * Req 8.1–8.8: Team KPIs, developer comparison, full task list,
 * bottleneck analysis, team rework, trend comparison, workload distribution
 * with 35% flagging, at-risk tasks.
 */
export function buildTeamReport(
  team: Team,
  developers: Developer[],
  devReports: DeveloperReport[],
  tasks: TaskSnapshot[],
  period: ReportPeriod,
  priorTasks: TaskSnapshot[],
  slaConfig: SlaThresholds,
): TeamReport {
  const periodEnd = period.end;

  // 1. Compute team KPIs (Req 8.1)
  const devKPIs = devReports.map((r) => r.kpis);
  const team_kpis = computeTeamKPIs(devKPIs, tasks, priorTasks, periodEnd, slaConfig);

  // 2. Prior team KPIs for trend comparison
  const priorDevKPIs = devReports.map((r) => r.trend_comparison.prior as DeveloperKPIs);
  const priorTeamKpis = computeTeamKPIs(priorDevKPIs, priorTasks, [], periodEnd, slaConfig);

  // 3. Developer comparison rows (Req 8.2)
  const developer_comparison: DeveloperComparisonRow[] = devReports.map((r) => ({
    developer_id: r.developer.clickup_user_id,
    developer_name: `${r.developer.first_name} ${r.developer.last_name}`,
    kpis: r.kpis,
  }));

  // 4. Full team task list without duplicates (Req 8.3)
  const full_task_list = buildFullTaskList(devReports);

  // 5. Bottleneck analysis (Req 8.4)
  const bottleneck_analysis = buildBottleneckAnalysis(tasks);

  // 6. Team rework analysis (Req 8.5)
  const team_rework_analysis = buildReworkAnalysis(tasks, slaConfig.rework_count_flag);

  // 7. Trend comparison (Req 8.6)
  const trend_comparison: TrendComparison = {
    current: team_kpis,
    prior: priorTeamKpis,
    deltas: computeTrendDeltas(team_kpis, priorTeamKpis),
  };

  // 8. Workload distribution with 35% flagging (Req 8.7)
  const { entries: workload_distribution, flags: workload_flags } = buildWorkloadDistribution(
    devReports,
    slaConfig.workload_imbalance_pct,
  );

  // 9. At-risk tasks (Req 8.8)
  const at_risk_tasks = flagTasks(tasks, slaConfig, periodEnd);

  return {
    team,
    period,
    team_kpis,
    developer_comparison,
    full_task_list,
    bottleneck_analysis,
    team_rework_analysis,
    trend_comparison,
    workload_distribution,
    workload_flags,
    at_risk_tasks,
  };
}
