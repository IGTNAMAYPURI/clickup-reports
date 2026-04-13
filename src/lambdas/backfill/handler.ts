/**
 * Backfill Lambda handler — generates historical reports for past periods
 * via API Gateway POST `/reports/backfill`.
 *
 * Accepts a JSON body with from_date and to_date (ISO 8601).
 * Enumerates all daily/weekly/monthly periods in the range, skips periods
 * with existing Report_Snapshots, and processes remaining periods with
 * controlled concurrency (default 2).
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8
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
import type { SlaThresholds } from '@src/config/config';
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
import { enumeratePeriods, formatSheetName, getPriorPeriod } from '@src/utils/date.utils';
import { createLogger } from '@src/utils/logger';
import type { Developer, TaskSnapshot, Team, ReportSnapshot } from '@src/types/db';
import type { DeveloperReport, ReportPeriod } from '@src/types/report';

const NAMESPACE = 'ClickUpReporting';
const cloudwatch = new CloudWatchClient({});
const secretsClient = new SecretsManagerClient({});

interface BackfillRequest {
  from_date: string; // ISO 8601
  to_date: string;   // ISO 8601
}

let cachedApiKey: string | null = null;

/**
 * Retrieves the expected API key from Secrets Manager or environment variable.
 */
async function getExpectedApiKey(): Promise<string> {
  if (cachedApiKey) return cachedApiKey;

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
 * Validates the API key from the request headers (Req 6.4, 6.6).
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
 * Validates the request body (Req 6.1, 6.5).
 * Returns the parsed request or an error message.
 */
function validateRequestBody(
  body: string | null,
): { request: BackfillRequest; fromDate: Date; toDate: Date } | { error: string } {
  if (!body) {
    return { error: 'Request body is required.' };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { error: 'Request body must be valid JSON.' };
  }

  // Validate from_date
  const fromDateStr = parsed.from_date;
  if (!fromDateStr || typeof fromDateStr !== 'string') {
    return { error: 'Missing required field: from_date.' };
  }
  const fromDate = parseISO8601(fromDateStr);
  if (!fromDate) {
    return { error: `Invalid from_date: "${fromDateStr}". Must be a valid ISO 8601 date.` };
  }

  // Validate to_date
  const toDateStr = parsed.to_date;
  if (!toDateStr || typeof toDateStr !== 'string') {
    return { error: 'Missing required field: to_date.' };
  }
  const toDate = parseISO8601(toDateStr);
  if (!toDate) {
    return { error: `Invalid to_date: "${toDateStr}". Must be a valid ISO 8601 date.` };
  }

  // Validate from_date <= to_date
  if (fromDate.getTime() > toDate.getTime()) {
    return { error: 'from_date must be before or equal to to_date.' };
  }

  return {
    request: { from_date: fromDateStr, to_date: toDateStr },
    fromDate,
    toDate,
  };
}

/**
 * Checks whether a report snapshot already exists for a given period and type.
 * Returns true if a snapshot with status 'success' or 'partial' exists (Req 6.7).
 */
async function reportExists(
  db: Db,
  period: ReportPeriod,
): Promise<boolean> {
  const count = await db
    .collection<ReportSnapshot>('report_snapshots')
    .countDocuments({
      report_type: period.type,
      period_start: period.start,
      period_end: period.end,
      status: { $in: ['success', 'partial'] },
    });
  return count > 0;
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
 * Processes a single report period: generates developer + team reports,
 * writes to Sheets, and saves a ReportSnapshot.
 */
async function processPeriod(
  db: Db,
  period: ReportPeriod,
  developers: Developer[],
  teams: Team[],
  slaConfig: SlaThresholds,
  correlationId: string,
  logger: ReturnType<typeof createLogger>,
): Promise<{
  totalRowsWritten: number;
  totalChartsCreated: number;
  status: ReportSnapshot['status'];
}> {
  const periodStart = Date.now();
  const priorPeriod = getPriorPeriod(period, period.type);
  const sheetName = formatSheetName(period, period.type);

  const allTasks = await queryAllTasksForPeriod(db, period);
  const allPriorTasks = await queryAllTasksForPeriod(db, priorPeriod);

  let totalRowsWritten = 0;
  let totalChartsCreated = 0;
  const failedDevelopers: string[] = [];
  const devReports: DeveloperReport[] = [];

  // Generate developer reports
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
    } catch (error) {
      logger.error(
        { developerId: developer.clickup_user_id, err: error },
        'Failed to generate report for developer — continuing',
      );
      failedDevelopers.push(developer.clickup_user_id);
    }
  }

  // Process each team
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
    } catch (error) {
      logger.error(
        { teamId: team.team_id, err: error },
        'Failed to process team report — continuing',
      );
    }
  }

  // Determine report status
  const status: ReportSnapshot['status'] =
    failedDevelopers.length === 0
      ? 'success'
      : failedDevelopers.length === developers.length
        ? 'failed'
        : 'partial';

  // Compute metrics summary
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

  const spreadsheetUrl =
    teams.length > 0
      ? `https://docs.google.com/spreadsheets/d/${teams[0].spreadsheet_id ?? 'unknown'}`
      : null;

  const durationMs = Date.now() - periodStart;

  await saveReportSnapshot(db, {
    report_type: period.type,
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

  return { totalRowsWritten, totalChartsCreated, status };
}

/**
 * Processes an array of periods with controlled concurrency.
 * Executes at most `concurrency` periods in parallel at any time (Req 6.3).
 */
async function processWithConcurrency(
  periods: ReportPeriod[],
  concurrency: number,
  processFn: (period: ReportPeriod) => Promise<{ status: ReportSnapshot['status'] }>,
): Promise<{ processed: number; failed: number; succeeded: number }> {
  let processed = 0;
  let failed = 0;
  let succeeded = 0;
  let index = 0;

  async function next(): Promise<void> {
    while (index < periods.length) {
      const currentIndex = index++;
      const period = periods[currentIndex];
      try {
        const result = await processFn(period);
        processed++;
        if (result.status === 'failed') {
          failed++;
        } else {
          succeeded++;
        }
      } catch {
        processed++;
        failed++;
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, periods.length) }, () => next());
  await Promise.all(workers);

  return { processed, failed, succeeded };
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
 * Invoked via API Gateway POST `/reports/backfill` (Req 6.1).
 *
 * Flow:
 * 1. Validate API key (Req 6.4, 6.6 → HTTP 401)
 * 2. Validate request body (Req 6.1, 6.5 → HTTP 400)
 * 3. Enumerate all daily/weekly/monthly periods in range (Req 6.2)
 * 4. Skip periods with existing Report_Snapshots (Req 6.7)
 * 5. Process remaining periods with controlled concurrency (Req 6.3)
 * 6. Return HTTP 200 with backfill summary
 */
export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const correlationId = randomUUID();
  const logger = createLogger({ correlationId, lambdaName: 'backfill' });
  const startTime = Date.now();

  logger.info({ correlationId }, 'Backfill Lambda invoked');

  // 1. Validate API key (Req 6.4, 6.6)
  const apiKeyError = await validateApiKey(event);
  if (apiKeyError) {
    logger.warn({ correlationId }, 'API key validation failed');
    return {
      statusCode: 401,
      body: JSON.stringify({ error: apiKeyError }),
    };
  }

  // 2. Validate request body (Req 6.1, 6.5)
  const validation = validateRequestBody(event.body);
  if ('error' in validation) {
    logger.warn({ correlationId, error: validation.error }, 'Request validation failed');
    return {
      statusCode: 400,
      body: JSON.stringify({ error: validation.error }),
    };
  }

  const { request, fromDate, toDate } = validation;

  logger.info(
    { fromDate: request.from_date, toDate: request.to_date },
    'Validated backfill request',
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
    // 4. Load SLA config (includes backfill_concurrency)
    const slaConfig = await loadSlaConfig(db);
    const concurrency = slaConfig.backfill_concurrency;

    // 5. Enumerate all periods in range (Req 6.2)
    const { daily, weekly, monthly } = enumeratePeriods(fromDate, toDate);
    const allPeriods: ReportPeriod[] = [...daily, ...weekly, ...monthly];

    logger.info(
      {
        dailyCount: daily.length,
        weeklyCount: weekly.length,
        monthlyCount: monthly.length,
        totalPeriods: allPeriods.length,
      },
      'Enumerated periods for backfill',
    );

    // 6. Filter out periods with existing Report_Snapshots (Req 6.7)
    const periodsToProcess: ReportPeriod[] = [];
    let skippedCount = 0;

    for (const period of allPeriods) {
      const exists = await reportExists(db, period);
      if (exists) {
        logger.info(
          { periodType: period.type, label: period.label },
          'Skipping period — report already exists',
        );
        skippedCount++;
      } else {
        periodsToProcess.push(period);
      }
    }

    logger.info(
      { toProcess: periodsToProcess.length, skipped: skippedCount },
      'Filtered periods for backfill',
    );

    // 7. Fetch developers and teams (shared across all periods)
    const developers = await fetchDevelopers(db);
    const teams = await fetchTeams(db);

    // 8. Process periods with controlled concurrency (Req 6.3)
    const results = await processWithConcurrency(
      periodsToProcess,
      concurrency,
      async (period) => {
        const result = await processPeriod(
          db,
          period,
          developers,
          teams,
          slaConfig,
          correlationId,
          logger,
        );
        return { status: result.status };
      },
    );

    // 9. Emit CloudWatch metrics
    const durationMs = Date.now() - startTime;

    try {
      await emitMetrics(durationMs, 0, 0);
    } catch (metricError) {
      logger.warn({ err: metricError }, 'Failed to emit CloudWatch metrics');
    }

    logger.info(
      {
        correlationId,
        durationMs,
        totalPeriods: allPeriods.length,
        skipped: skippedCount,
        processed: results.processed,
        succeeded: results.succeeded,
        failed: results.failed,
      },
      'Backfill Lambda completed',
    );

    // 10. Return success response
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Backfill completed.',
        from_date: request.from_date,
        to_date: request.to_date,
        total_periods: allPeriods.length,
        skipped: skippedCount,
        processed: results.processed,
        succeeded: results.succeeded,
        failed: results.failed,
        duration_ms: durationMs,
      }),
    };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    logger.error({ err: error, correlationId }, 'Backfill Lambda failed');

    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error.' }),
    };
  }
};
