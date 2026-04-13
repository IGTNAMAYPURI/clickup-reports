import { ChartSpec } from '@src/types/sheets';
import { DeveloperReport, TeamReport } from '@src/types/report';

const CHART_WIDTH = 600 as const;
const CHART_HEIGHT = 371 as const;
const CHART_OFFSET_X = 800;
const CHART_VERTICAL_SPACING = 400;

function makeChartPosition(sheetId: number, index: number): ChartSpec['position'] {
  return {
    sheetId,
    offsetXPixels: CHART_OFFSET_X,
    offsetYPixels: index * CHART_VERTICAL_SPACING,
  };
}

function makeChartSize(): ChartSpec['size'] {
  return { width: CHART_WIDTH, height: CHART_HEIGHT };
}

/**
 * Builds chart specs for a developer report sheet.
 *
 * Charts:
 *  1. Bar — Tasks by status
 *  2. Line — Daily closed-task trend
 *  3. Pie — Priority distribution
 *  4. Bar — Estimated vs logged time
 */
export function buildDeveloperCharts(
  report: DeveloperReport,
  sheetId: number,
): ChartSpec[] {
  const charts: ChartSpec[] = [];

  // 1. Bar chart: Tasks by status
  // Data: status labels + counts (4 statuses)
  const statusCount = 4; // not_started, active, done_in_qa, closed_completed
  charts.push({
    type: 'BAR',
    title: 'Tasks by Status',
    dataRange: {
      sheetId,
      startRowIndex: 0,
      endRowIndex: statusCount + 1, // header + data rows
      startColumnIndex: 0,
      endColumnIndex: 2, // status label, count
    },
    position: makeChartPosition(sheetId, 0),
    size: makeChartSize(),
  });

  // 2. Line chart: Daily closed-task trend
  // Data: date labels + closed count per day
  const taskBreakdownRows = report.task_breakdown.length;
  charts.push({
    type: 'LINE',
    title: 'Daily Closed Task Trend',
    dataRange: {
      sheetId,
      startRowIndex: 0,
      endRowIndex: taskBreakdownRows + 1, // header + data rows
      startColumnIndex: 0,
      endColumnIndex: 2, // date, count
    },
    position: makeChartPosition(sheetId, 1),
    size: makeChartSize(),
  });

  // 3. Pie chart: Priority distribution
  const priorityKeys = Object.keys(report.priority_distribution);
  const priorityRowCount = Math.max(priorityKeys.length, 1);
  charts.push({
    type: 'PIE',
    title: 'Priority Distribution',
    dataRange: {
      sheetId,
      startRowIndex: 0,
      endRowIndex: priorityRowCount + 1, // header + data rows
      startColumnIndex: 0,
      endColumnIndex: 2, // priority label, count
    },
    position: makeChartPosition(sheetId, 2),
    size: makeChartSize(),
  });

  // 4. Bar chart: Estimated vs Logged Time
  charts.push({
    type: 'BAR',
    title: 'Estimated vs Logged Time',
    dataRange: {
      sheetId,
      startRowIndex: 0,
      endRowIndex: 2, // header + 1 data row (estimated, logged)
      startColumnIndex: 0,
      endColumnIndex: 3, // label, estimated, logged
    },
    position: makeChartPosition(sheetId, 3),
    size: makeChartSize(),
  });

  return charts;
}

/**
 * Builds chart specs for a team report sheet.
 *
 * Charts:
 *  1. Stacked Bar — Tasks per developer by status
 *  2. Line — Velocity trend
 *  3. Bar — Rework count per developer
 *  4. Pie — Workload distribution
 *  5. Bar — Average PR review time per developer
 *  6. Bar — Average QA time per developer
 */
export function buildTeamCharts(
  report: TeamReport,
  sheetId: number,
): ChartSpec[] {
  const charts: ChartSpec[] = [];
  const devCount = report.developer_comparison.length;
  const devRows = Math.max(devCount, 1);

  // 1. Stacked Bar: Tasks per developer by status
  charts.push({
    type: 'STACKED_BAR',
    title: 'Tasks per Developer by Status',
    dataRange: {
      sheetId,
      startRowIndex: 0,
      endRowIndex: devRows + 1, // header + one row per developer
      startColumnIndex: 0,
      endColumnIndex: 5, // dev name, not_started, active, done_in_qa, closed_completed
    },
    position: makeChartPosition(sheetId, 0),
    size: makeChartSize(),
  });

  // 2. Line: Velocity trend
  charts.push({
    type: 'LINE',
    title: 'Team Velocity Trend',
    dataRange: {
      sheetId,
      startRowIndex: 0,
      endRowIndex: devRows + 1,
      startColumnIndex: 0,
      endColumnIndex: 2, // period label, velocity
    },
    position: makeChartPosition(sheetId, 1),
    size: makeChartSize(),
  });

  // 3. Bar: Rework count per developer
  charts.push({
    type: 'BAR',
    title: 'Rework Count per Developer',
    dataRange: {
      sheetId,
      startRowIndex: 0,
      endRowIndex: devRows + 1,
      startColumnIndex: 0,
      endColumnIndex: 2, // dev name, rework count
    },
    position: makeChartPosition(sheetId, 2),
    size: makeChartSize(),
  });

  // 4. Pie: Workload distribution
  const workloadEntries = report.workload_distribution.length;
  const workloadRows = Math.max(workloadEntries, 1);
  charts.push({
    type: 'PIE',
    title: 'Workload Distribution',
    dataRange: {
      sheetId,
      startRowIndex: 0,
      endRowIndex: workloadRows + 1,
      startColumnIndex: 0,
      endColumnIndex: 2, // dev name, task count / percentage
    },
    position: makeChartPosition(sheetId, 3),
    size: makeChartSize(),
  });

  // 5. Bar: Average PR review time per developer
  charts.push({
    type: 'BAR',
    title: 'Avg PR Review Time per Developer',
    dataRange: {
      sheetId,
      startRowIndex: 0,
      endRowIndex: devRows + 1,
      startColumnIndex: 0,
      endColumnIndex: 2, // dev name, avg PR time
    },
    position: makeChartPosition(sheetId, 4),
    size: makeChartSize(),
  });

  // 6. Bar: Average QA time per developer
  charts.push({
    type: 'BAR',
    title: 'Avg QA Time per Developer',
    dataRange: {
      sheetId,
      startRowIndex: 0,
      endRowIndex: devRows + 1,
      startColumnIndex: 0,
      endColumnIndex: 2, // dev name, avg QA time
    },
    position: makeChartPosition(sheetId, 5),
    size: makeChartSize(),
  });

  return charts;
}
