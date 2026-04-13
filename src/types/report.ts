import { Developer, TaskSnapshot, Team } from '@src/types/db';

export type NormalizedStatus = 'not_started' | 'active' | 'done_in_qa' | 'closed_completed';

export type AtRiskFlag = 'overdue' | 'inactive' | 'open_too_long' | 'high_rework';

export type FlagSeverity = 'red' | 'orange' | 'yellow';

export interface ReportPeriod {
  start: Date;
  end: Date;
  type: 'daily' | 'weekly' | 'monthly';
  label: string; // e.g., "Daily_2024-01-15", "Weekly_2024-W03", "Monthly_2024-01"
}

export interface DeveloperKPIs {
  tasks_closed: number;
  tasks_in_progress: number;
  tasks_in_qa: number;
  tasks_opened: number;
  subtasks_closed: number;
  overdue_tasks: number;
  at_risk_tasks: number;
  story_points_completed: number;
  time_logged_ms: number;
  estimated_vs_logged_ratio: number | null;
  completion_rate: number;
  average_task_age_days: number;
  average_time_in_pr_ms: number;
  average_time_in_qa_ms: number;
  total_rework_count: number;
  high_rework_task_count: number;
  velocity_delta: number | null; // % change vs prior period
}

export interface TeamKPIs {
  tasks_closed: number;
  tasks_in_progress: number;
  tasks_in_qa: number;
  tasks_opened: number;
  subtasks_closed: number;
  overdue_tasks: number;
  at_risk_tasks: number;
  story_points_completed: number;
  time_logged_ms: number;
  estimated_vs_logged_ratio: number | null;
  completion_rate: number;
  average_task_age_days: number;
  average_time_in_pr_ms: number;
  average_time_in_qa_ms: number;
  total_rework_count: number;
  high_rework_task_count: number;
  velocity_delta: number | null;
}

export interface DeveloperReport {
  developer: Developer;
  period: ReportPeriod;
  kpis: DeveloperKPIs;
  task_breakdown: TaskBreakdownRow[];
  status_flow: StatusFlowEntry[];
  priority_distribution: Record<string, number>;
  rework_analysis: ReworkAnalysis;
  trend_comparison: TrendComparison;
  at_risk_tasks: FlaggedTask[];
}

export interface DeveloperComparisonRow {
  developer_id: string;
  developer_name: string;
  kpis: DeveloperKPIs;
}

export interface TeamReport {
  team: Team;
  period: ReportPeriod;
  team_kpis: TeamKPIs;
  developer_comparison: DeveloperComparisonRow[];
  full_task_list: TaskBreakdownRow[];
  bottleneck_analysis: BottleneckEntry[];
  team_rework_analysis: ReworkAnalysis;
  trend_comparison: TrendComparison;
  workload_distribution: WorkloadEntry[];
  workload_flags: string[]; // developer IDs exceeding 35% threshold
  at_risk_tasks: FlaggedTask[];
}

export interface TaskBreakdownRow {
  task_id: string;
  task_name: string;
  parent_task_id: string | null;
  is_subtask: boolean;
  list_folder: string;
  status: string;
  priority: string;
  story_points: number | null;
  rework_count: number;
  time_estimated_ms: number | null;
  time_logged_ms: number | null;
  due_date: Date | null;
  date_closed: Date | null;
  on_time: boolean | null;
  days_open: number;
  last_activity: Date;
  at_risk_flag: AtRiskFlag | null;
  tags: string[];
  clickup_url: string;
}

export interface FlaggedTask {
  task: TaskSnapshot;
  flags: AtRiskFlag[];
  highest_severity: FlagSeverity;
}

export interface ReworkAnalysis {
  total_rework_count: number;
  flagged_tasks: TaskSnapshot[];
  top_5_reworked: TaskSnapshot[];
}

export interface TrendComparison {
  current: DeveloperKPIs | TeamKPIs;
  prior: DeveloperKPIs | TeamKPIs;
  deltas: Record<string, number | null>; // % change per metric
}

export interface StatusFlowEntry {
  task_id: string;
  task_name: string;
  status_durations: Record<string, number>; // status → ms
}

export interface BottleneckEntry {
  status: string;
  task_count: number;
  percentage: number;
  average_time_ms: number;
}

export interface WorkloadEntry {
  developer_id: string;
  developer_name: string;
  metric_name: string;
  value: number;
  percentage_of_team: number;
  flagged: boolean;
}
