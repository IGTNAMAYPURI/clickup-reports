/**
 * Manual Trigger Lambda handler — generates reports on demand via
 * API Gateway POST `/reports/generate`.
 *
 * Accepts a JSON body with report_type, period_start, and period_end.
 * Validates API key authentication and request body before delegating
 * to the same report generation logic used by the scheduled Lambdas.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6
 */

import { randomUUID } from 'crypto';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  CloudWatchClient,
  PutMetricDataCommand,
} from '@aws-sdk/client-cloudwatch';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
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
import { formatSheetName, getPriorPeriod } from '@src/utils/date.utils';
import { createLogger } from '@src/utils/logger';
import { getAwsClientConfig } from '@src/utils/aws-client.config';
import type { Developer, TaskSnapshot, Team, ReportSnapshot } from '@src/types/db';
import type { DeveloperReport, ReportPeriod } from '@src/types/report';

const NAMESPACE = 'ClickUpReporting';
const cloudwatch = new CloudWatchClient(getAwsClientConfig());
const secretsClient = new SecretsManagerClient(getAwsClientConfig());

const VALID_REPORT_TYPES = ['daily', 'weekly', 'monthly'] as const;
type ReportType = (typeof VALID_REPORT_TYPES)[number];

interface ManualTriggerRequest {
  report_type: ReportType;
  period_start: string; // ISO 8601
  period_end: string;   // ISO 8601
}

let cachedApiKey: string | null = null;

/**
 * Retrieves the expected API key from Secrets Manager or environment variable.
 */
async function getExpectedApiKey(): Promise<string> {
  if (cachedApiKey) return cachedApiKey;

  // Prefer environment variable for simple setups
  if (process.env.API_KEY) {
    cachedApiKey = process.env.API_KEY;
    return cachedApiKey;
  }

  const secretId = process.env.API_KEY_SECRET_NAME ?? 'clickup-reporting/api-key';
  const result = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: secretId }),
  );

  if (!result.SecretString) {
    throw new Error('API key secret is empty');
  }

  cachedApiKey = result.SecretString;
  return cachedApiKey;
}

/**
 * Validates the API key from the request headers (Req 5.3, 5.5).
 * Returns null if valid, or an error message string if invalid.
 */
async function validateApiKey(event: APIGatewayProxyEvent): Promise<string | null> {
  const apiKey =
    event.headers['x-api-key'] ??
    event.headers['X-Api-Key'] ??
    event.headers['X-API-KEY'];

  if (!apiKey) {
    return 'Missing API key. Provide a valid key in the x-api-key header.';
  }

  try {
    const expectedKey = await getExpectedApiKey();
    if (apiKey !== expectedKey) {
      return 'Invalid API key.';
    }
  } catch {
    return 'Unable to validate API key.';
  }

  return null;
}

/**
 * Validates that a string is a valid ISO 8601 date and returns the parsed Date.
 * Returns null if the string is not a valid date.
 */
function parseISO8601(value: string): Date | null {
  const date = new Date(value);
  if (isNaN(date.getTime())) return null;
  return date;
}

/**
 * Validates the request body (Req 5.1, 5.4).
 * Returns the parsed request or an error message.
 */
function validateRequestBody(
  body: string | null,
): { request: ManualTriggerRequest; period: ReportPeriod } | { error: string } {
  if (!body) {
    return { error: 'Request body is required.' };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { error: 'Request body must be valid JSON.' };
  }

  // Validate report_type
  const reportType = parsed.report_type;
  if (!reportType || typeof reportType !== 'string') {
    return { error: 'Missing required field: report_type.' };
  }
  if (!VALID_REPORT_TYPES.includes(reportType as ReportType)) {
    return {
      error: `Invalid report_type: "${reportType}". Must be one of: daily, weekly, monthly.`,
    };
  }

  // Validate period_start
  const periodStartStr = parsed.period_start;
  if (!periodStartStr || typeof periodStartStr !== 'string') {
    return { error: 'Missing required field: period_start.' };
  }
  const periodStart = parseISO8601(periodStartStr);
  if (!periodStart) {
    return { error: `Invalid period_start: "${periodStartStr}". Must be a valid ISO 8601 date.` };
  }

  // Validate period_end
  const periodEndStr = parsed.period_end;
  if (!periodEndStr || typeof periodEndStr !== 'string') {
    return { error: 'Missing required field: period_end.' };
  }
  const periodEnd = parseISO8601(periodEndStr);
  if (!periodEnd) {
    return { error: `Invalid period_end: "${periodEndStr}". Must be a valid ISO 8601 date.` };
  }

  // Validate period_start <= period_end
  if (periodStart.getTime() > periodEnd.getTime()) {
    return { error: 'period_start must be before or equal to period_end.' };
  }

  const type = reportType as ReportType;
  const period: ReportPeriod = {
    start: periodStart,
    end: periodEnd,
    type,
    label: formatSheetName({ start: periodStart, end: periodEnd, type, label: '' }, type),
  };

  return {
    request: {
      report_type: type,
      period_start: periodStartStr,
      period_end: periodEndStr,
    },
    period,
  };
}

/**
 * Queries all task_snapshots within a period.
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
 * Fetches all active developers.
 */
async function fetchDevelopers(db: Db): Promise<Developer[]> {
  return db
    .collection<Developer>('developers')
    .find({ active: true })
    .toArray();
}

/**
 * Fetches all teams.
 */
async function fetchTeams(db: Db): Promise<Team[]> {
  return db.collection<Team>('teams').find({}).toArray();
}

/**
 * Writes a developer report to a sheet. Returns rows written and charts created.
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
 * Writes the team report to a sheet. Returns rows written and charts created.
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
 * Saves a ReportSnapshot to MongoDB.
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
 * Resets the cached API key. Intended for test isolation only.
 * @internal
 */
export function _resetApiKeyCacheForTesting(): void {
  cachedApiKey = null;
}

/**
 * Lambda handler entry point.
 * Invoked via API Gateway POST `/reports/generate` (Req 5.1).
 *
 * Flow:
 * 1. Validate API key (Req 5.3, 5.5 → HTTP 401)
 * 2. Validate request body (Req 5.1, 5.4 → HTTP 400)
 * 3. Generate report using the same logic as scheduled Lambdas (Req 5.2)
 * 4. Return HTTP 200 with report metadata
 */
export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const correlationId = randomUUID();
  const logger = createLogger({ correlationId, lambdaName: 'report-manual' });
  const startTime = Date.now();

  logger.info({ correlationId }, 'Manual Trigger Lambda invoked');

  // 1. Validate API key (Req 5.3, 5.5)
  const apiKeyError = await validateApiKey(event);
  if (apiKeyError) {
    logger.warn({ correlationId }, 'API key validation failed');
    return {
      statusCode: 401,
      body: JSON.stringify({ error: apiKeyError }),
    };
  }

  // 2. Validate request body (Req 5.1, 5.4)
  const validation = validateRequestBody(event.body);
  if ('error' in validation) {
    logger.warn({ correlationId, error: validation.error }, 'Request validation failed');
    return {
      statusCode: 400,
      body: JSON.stringify({ error: validation.error }),
    };
  }

  const { request, period } = validation;
  const priorPeriod = getPriorPeriod(period, request.report_type);
  const sheetName = formatSheetName(period, request.report_type);

  logger.info(
    {
      reportType: request.report_type,
      period: { start: period.start, end: period.end },
      sheetName,
    },
    'Validated manual trigger request',
  );

  // 3. Connect to MongoDB
  let db: Db;
  try {
    db = await getDb();
  } catch (error) {
    logger.error({ err: error, correlationId }, 'Failed to connect to MongoDB');
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error.' }),
    };
  }

  try {
    // 4. Load SLA config
    const slaConfig = await loadSlaConfig(db);

    // 5. Fetch developers and teams
    const developers = await fetchDevelopers(db);
    const teams = await fetchTeams(db);

    logger.info(
      { developerCount: developers.length, teamCount: teams.length },
      'Loaded developers and teams',
    );

    // 6. Query tasks for the period and prior period
    const allTasks = await queryAllTasksForPeriod(db, period);
    const allPriorTasks = await queryAllTasksForPeriod(db, priorPeriod);

    let totalRowsWritten = 0;
    let totalChartsCreated = 0;
    const failedDevelopers: string[] = [];
    const devReports: DeveloperReport[] = [];

    // 7. Generate developer reports (Req 5.2 — same logic as scheduled Lambdas)
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
          { developerId: developer.clickup_user_id, taskCount: devTasks.length },
          'Built developer report',
        );
      } catch (error) {
        logger.error(
          { developerId: developer.clickup_user_id, err: error },
          'Failed to generate report for developer — continuing',
        );
        failedDevelopers.push(developer.clickup_user_id);
      }
    }

    // 8. Process each team
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
              { developerId: devReport.developer.clickup_user_id, err: error },
              'Failed to write developer sheet — continuing',
            );
            if (!failedDevelopers.includes(devReport.developer.clickup_user_id)) {
              failedDevelopers.push(devReport.developer.clickup_user_id);
            }
          }
        }

        // Build and write team report
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

    // 9. Emit CloudWatch metrics
    const durationMs = Date.now() - startTime;

    try {
      await emitMetrics(durationMs, totalRowsWritten, totalChartsCreated);
    } catch (metricError) {
      logger.warn({ err: metricError }, 'Failed to emit CloudWatch metrics');
    }

    // 10. Determine report status
    const status: ReportSnapshot['status'] =
      failedDevelopers.length === 0
        ? 'success'
        : failedDevelopers.length === developers.length
          ? 'failed'
          : 'partial';

    // 11. Compute metrics summary
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

    // 12. Save Report_Snapshot to MongoDB
    const spreadsheetUrl =
      teams.length > 0
        ? `https://docs.google.com/spreadsheets/d/${teams[0].spreadsheet_id ?? 'unknown'}`
        : null;

    await saveReportSnapshot(db, {
      report_type: request.report_type,
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
      'Manual Trigger Lambda completed',
    );

    // 13. Return success response (Req 5.2)
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Report generated successfully.',
        report_type: request.report_type,
        period_start: request.period_start,
        period_end: request.period_end,
        status,
        duration_ms: durationMs,
        spreadsheet_url: spreadsheetUrl,
        metrics_summary: metricsSummary,
      }),
    };
  } catch (error) {
    // Record failure in report_snapshots
    const durationMs = Date.now() - startTime;
    const err = error instanceof Error ? error : new Error(String(error));

    try {
      await saveReportSnapshot(db, {
        report_type: request.report_type,
        period_start: period.start,
        period_end: period.end,
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

    logger.error({ err: error, correlationId }, 'Manual Trigger Lambda failed');

    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error.' }),
    };
  }
};
