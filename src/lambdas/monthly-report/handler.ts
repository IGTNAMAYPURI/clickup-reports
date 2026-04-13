/**
 * Monthly Report Lambda handler — generates developer and team reports
 * for the previous month and publishes them to Google Sheets.
 *
 * Triggered at 00:15 UTC on the 1st of each month by EventBridge.
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7
 */

import { randomUUID } from 'crypto';
import {
  CloudWatchClient,
  PutMetricDataCommand,
} from '@aws-sdk/client-cloudwatch';
import type { Db } from 'mongodb';

import { loadSlaConfig } from '@src/config/config';
import { getDb } from '@src/services/db/connection';
import { buildDeveloperReport, buildTeamReport } from '@src/services/reports/builder';
import { buildDeveloperCharts, buildTeamCharts } from '@src/services/reports/chart-builder';
import {
  getOrCreateSpreadsheet,
  createSheet,
  writeData,
  applyFormatting,
  createChart,
  deleteCharts,
  protectSheet,
} from '@src/services/sheets/client';
import { DEFAULT_SHEET_FORMAT, formatTaskBreakdownData } from '@src/services/sheets/formatter';
import { getMonthlyPeriod, getPriorPeriod, formatSheetName } from '@src/utils/date.utils';
import { createLogger } from '@src/utils/logger';
import type { Developer, TaskSnapshot, Team, ReportSnapshot } from '@src/types/db';
import type { DeveloperReport, ReportPeriod } from '@src/types/report';

const NAMESPACE = 'ClickUpReporting';
const cloudwatch = new CloudWatchClient({});

/**
 * Queries all task_snapshots within a period across all developers.
 */
async function queryAllTasksForPeriod(
  db: Db,
  period: ReportPeriod,
): Promise<TaskSnapshot[]> {
  return db
    .collection<TaskSnapshot>('task_snapshots')
    .find({
      date_updated: { $gte: period.start, $lte: period.end },
    })
    .toArray();
}

/**
 * Fetches all active developers from the developers collection.
 */
async function fetchDevelopers(db: Db): Promise<Developer[]> {
  return db
    .collection<Developer>('developers')
    .find({ active: true })
    .toArray();
}

/**
 * Fetches all teams from the teams collection.
 */
async function fetchTeams(db: Db): Promise<Team[]> {
  return db.collection<Team>('teams').find({}).toArray();
}

/**
 * Writes a developer report to a sheet within the spreadsheet.
 * Returns the number of rows written and charts created.
 */
async function writeDeveloperSheet(
  spreadsheetId: string,
  sheetName: string,
  report: DeveloperReport,
): Promise<{ rowsWritten: number; chartsCreated: number }> {
  const sheetId = await createSheet(spreadsheetId, sheetName);

  const { headers, formattedRows } = formatTaskBreakdownData(report.task_breakdown);
  const values: unknown[][] = [
    headers,
    ...formattedRows.map((r) => r.values),
  ];

  await writeData(spreadsheetId, `${sheetName}!A1`, values);
  await applyFormatting(spreadsheetId, sheetId, DEFAULT_SHEET_FORMAT);

  await deleteCharts(spreadsheetId, sheetId);
  const chartSpecs = buildDeveloperCharts(report, sheetId);
  for (const chart of chartSpecs) {
    await createChart(spreadsheetId, sheetId, chart);
  }

  await protectSheet(spreadsheetId, sheetId);

  return {
    rowsWritten: values.length,
    chartsCreated: chartSpecs.length,
  };
}

/**
 * Writes the team report to a sheet within the spreadsheet.
 * Returns the number of rows written and charts created.
 */
async function writeTeamSheet(
  spreadsheetId: string,
  sheetName: string,
  report: ReturnType<typeof buildTeamReport>,
): Promise<{ rowsWritten: number; chartsCreated: number }> {
  const sheetId = await createSheet(spreadsheetId, sheetName);

  const { headers, formattedRows } = formatTaskBreakdownData(report.full_task_list);
  const values: unknown[][] = [
    headers,
    ...formattedRows.map((r) => r.values),
  ];

  await writeData(spreadsheetId, `${sheetName}!A1`, values);
  await applyFormatting(spreadsheetId, sheetId, DEFAULT_SHEET_FORMAT);

  await deleteCharts(spreadsheetId, sheetId);
  const chartSpecs = buildTeamCharts(report, sheetId);
  for (const chart of chartSpecs) {
    await createChart(spreadsheetId, sheetId, chart);
  }

  await protectSheet(spreadsheetId, sheetId);

  return {
    rowsWritten: values.length,
    chartsCreated: chartSpecs.length,
  };
}

/**
 * Emits CloudWatch metrics for report generation.
 */
async function emitMetrics(
  durationMs: number,
  rowsWritten: number,
  chartsCreated: number,
): Promise<void> {
  await cloudwatch.send(
    new PutMetricDataCommand({
      Namespace: NAMESPACE,
      MetricData: [
        {
          MetricName: 'ReportGenerationDurationMs',
          Value: durationMs,
          Unit: 'Milliseconds',
          Timestamp: new Date(),
        },
        {
          MetricName: 'SheetsRowsWritten',
          Value: rowsWritten,
          Unit: 'Count',
          Timestamp: new Date(),
        },
        {
          MetricName: 'ChartsCreated',
          Value: chartsCreated,
          Unit: 'Count',
          Timestamp: new Date(),
        },
      ],
    }),
  );
}

/**
 * Saves a ReportSnapshot to MongoDB (Req 4.5).
 */
async function saveReportSnapshot(
  db: Db,
  snapshot: Omit<ReportSnapshot, '_id'>,
): Promise<void> {
  await db.collection<ReportSnapshot>('report_snapshots').insertOne(
    snapshot as ReportSnapshot,
  );
}

/**
 * Lambda handler entry point.
 * Triggered by EventBridge at 00:15 UTC on the 1st of each month (Req 4.1).
 */
export const handler = async (_event: unknown): Promise<void> => {
  const correlationId = randomUUID();
  const logger = createLogger({ correlationId, lambdaName: 'report-monthly' });
  const startTime = Date.now();

  logger.info({ correlationId }, 'Monthly Report Lambda invoked');

  let db: Db;
  try {
    db = await getDb();
  } catch (error) {
    logger.error({ err: error, correlationId }, 'Failed to connect to MongoDB');
    throw error;
  }

  try {
    // 1. Compute monthly period: 1st–last day of previous month UTC (Req 4.2)
    const now = new Date();
    const period = getMonthlyPeriod(now);
    const priorPeriod = getPriorPeriod(period, 'monthly');
    const sheetName = formatSheetName(period, 'monthly');

    logger.info(
      { period: { start: period.start, end: period.end }, sheetName },
      'Computed monthly period',
    );

    // 2. Load SLA config
    const slaConfig = await loadSlaConfig(db);

    // 3. Fetch developers and teams
    const developers = await fetchDevelopers(db);
    const teams = await fetchTeams(db);

    logger.info(
      { developerCount: developers.length, teamCount: teams.length },
      'Loaded developers and teams',
    );

    // 4. Query all tasks for the period (Req 4.2)
    const allTasks = await queryAllTasksForPeriod(db, period);
    const allPriorTasks = await queryAllTasksForPeriod(db, priorPeriod);

    let totalRowsWritten = 0;
    let totalChartsCreated = 0;
    const failedDevelopers: string[] = [];
    const devReports: DeveloperReport[] = [];

    // 5. Generate developer reports (Req 4.2, 4.6)
    for (const developer of developers) {
      try {
        const devTasks = allTasks.filter(
          (t) => t.assignee_id === developer.clickup_user_id,
        );
        const devPriorTasks = allPriorTasks.filter(
          (t) => t.assignee_id === developer.clickup_user_id,
        );

        const devReport = buildDeveloperReport(
          developer,
          devTasks,
          period,
          devPriorTasks,
          slaConfig,
        );
        devReports.push(devReport);

        logger.info(
          {
            developerId: developer.clickup_user_id,
            taskCount: devTasks.length,
          },
          'Built developer report',
        );
      } catch (error) {
        // Req 4.6: Log per-developer failures, continue processing
        logger.error(
          {
            developerId: developer.clickup_user_id,
            err: error,
          },
          'Failed to generate report for developer — continuing',
        );
        failedDevelopers.push(developer.clickup_user_id);
      }
    }

    // 6. Process each team (Req 4.3, 4.4)
    for (const team of teams) {
      try {
        const spreadsheetId = await getOrCreateSpreadsheet(team.name);

        const teamDevs = developers.filter((d) => d.team_id === team.team_id);
        const teamDevReports = devReports.filter((r) =>
          teamDevs.some(
            (d) => d.clickup_user_id === r.developer.clickup_user_id,
          ),
        );

        // Write individual developer sheets
        for (const devReport of teamDevReports) {
          try {
            const devSheetName = `Dev_${devReport.developer.first_name}_${devReport.developer.last_name}`;
            const { rowsWritten, chartsCreated } = await writeDeveloperSheet(
              spreadsheetId,
              devSheetName,
              devReport,
            );
            totalRowsWritten += rowsWritten;
            totalChartsCreated += chartsCreated;
          } catch (error) {
            logger.error(
              {
                developerId: devReport.developer.clickup_user_id,
                err: error,
              },
              'Failed to write developer sheet — continuing',
            );
            if (!failedDevelopers.includes(devReport.developer.clickup_user_id)) {
              failedDevelopers.push(devReport.developer.clickup_user_id);
            }
          }
        }

        // Build and write team report (Req 4.3)
        const teamTasks = allTasks.filter((t) =>
          teamDevs.some((d) => d.clickup_user_id === t.assignee_id),
        );
        const teamPriorTasks = allPriorTasks.filter((t) =>
          teamDevs.some((d) => d.clickup_user_id === t.assignee_id),
        );

        const teamReport = buildTeamReport(
          team,
          teamDevs,
          teamDevReports,
          teamTasks,
          period,
          teamPriorTasks,
          slaConfig,
        );

        // Write team sheet with the monthly sheet name (Req 4.4)
        const { rowsWritten, chartsCreated } = await writeTeamSheet(
          spreadsheetId,
          sheetName,
          teamReport,
        );
        totalRowsWritten += rowsWritten;
        totalChartsCreated += chartsCreated;

        logger.info(
          { teamId: team.team_id, sheetName },
          'Team report written to sheet',
        );
      } catch (error) {
        logger.error(
          { teamId: team.team_id, err: error },
          'Failed to process team report — continuing',
        );
      }
    }

    // 7. Compute duration and emit metrics (Req 18.2)
    const durationMs = Date.now() - startTime;

    try {
      await emitMetrics(durationMs, totalRowsWritten, totalChartsCreated);
    } catch (metricError) {
      logger.warn({ err: metricError }, 'Failed to emit CloudWatch metrics');
    }

    // 8. Determine report status
    const status: ReportSnapshot['status'] =
      failedDevelopers.length === 0
        ? 'success'
        : failedDevelopers.length === developers.length
          ? 'failed'
          : 'partial';

    // 9. Compute metrics summary
    const closedTasks = allTasks.filter(
      (t) => t.normalized_status === 'closed_completed',
    );
    const metricsSummary = {
      total_tasks: allTasks.length,
      tasks_closed: closedTasks.length,
      tasks_opened: allTasks.filter(
        (t) => t.date_created >= period.start && t.date_created <= period.end,
      ).length,
      story_points_completed: closedTasks.reduce(
        (sum, t) => sum + (t.story_points ?? 0),
        0,
      ),
    };

    // 10. Save Report_Snapshot to MongoDB (Req 4.5)
    const spreadsheetUrl =
      teams.length > 0
        ? `https://docs.google.com/spreadsheets/d/${teams[0].spreadsheet_id ?? 'unknown'}`
        : null;

    await saveReportSnapshot(db, {
      report_type: 'monthly',
      period_start: period.start,
      period_end: period.end,
      team_id: teams.length > 0 ? teams[0].team_id : 'unknown',
      status,
      failed_developers: failedDevelopers,
      metrics_summary: metricsSummary,
      spreadsheet_url: spreadsheetUrl,
      correlation_id: correlationId,
      generated_at: new Date(),
      duration_ms: durationMs,
    });

    logger.info(
      {
        correlationId,
        status,
        durationMs,
        totalRowsWritten,
        totalChartsCreated,
        failedDevelopers,
      },
      'Monthly Report Lambda completed',
    );
  } catch (error) {
    // Record failure in report_snapshots (Req 17.6)
    const durationMs = Date.now() - startTime;
    const err = error instanceof Error ? error : new Error(String(error));

    try {
      await saveReportSnapshot(db, {
        report_type: 'monthly',
        period_start: new Date(),
        period_end: new Date(),
        team_id: 'unknown',
        status: 'failed',
        failed_developers: [],
        metrics_summary: {
          total_tasks: 0,
          tasks_closed: 0,
          tasks_opened: 0,
          story_points_completed: 0,
        },
        spreadsheet_url: null,
        error_message: err.message,
        error_stack: err.stack,
        correlation_id: correlationId,
        generated_at: new Date(),
        duration_ms: durationMs,
      });
    } catch (snapshotError) {
      logger.error(
        { err: snapshotError },
        'Failed to save error report snapshot',
      );
    }

    logger.error({ err: error, correlationId }, 'Monthly Report Lambda failed');
    throw error; // Let Lambda runtime send to DLQ
  }
};
