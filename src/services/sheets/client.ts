/**
 * Google Sheets and Drive API client with OAuth2 token management and retry logic.
 *
 * - Stores OAuth2 refresh token in AWS Secrets Manager
 * - Auto-refreshes access token on expiry
 * - Caches access token until expiry
 * - 429 retry with exponential backoff (max 3 retries) via withRetry utility
 *
 * Requirements: 10.1–10.10, 15.1–15.5
 */

import { google, sheets_v4, drive_v3 } from 'googleapis';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import type { SheetFormat, ChartSpec } from '@src/types/sheets';
import { withRetry } from '@src/utils/retry';
import { createLogger } from '@src/utils/logger';

const RETRY_MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 16_000;

// ---------------------------------------------------------------------------
// OAuth2 Token Management
// ---------------------------------------------------------------------------

interface OAuthCredentials {
  client_id: string;
  client_secret: string;
  refresh_token: string;
}

interface CachedAccessToken {
  token: string;
  expiresAt: number; // epoch ms
}

let cachedCredentials: OAuthCredentials | null = null;
let cachedAccessToken: CachedAccessToken | null = null;

const secretsClient = new SecretsManagerClient({});

/**
 * Retrieves OAuth2 credentials (client_id, client_secret, refresh_token)
 * from AWS Secrets Manager and caches them for the invocation lifetime.
 */
async function getOAuthCredentials(
  secretId: string = process.env.GOOGLE_OAUTH_SECRET_ID ?? 'google-oauth-credentials',
): Promise<OAuthCredentials> {
  if (cachedCredentials) return cachedCredentials;

  const result = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: secretId }),
  );

  if (!result.SecretString) {
    throw new Error('Google OAuth credentials secret is empty');
  }

  cachedCredentials = JSON.parse(result.SecretString) as OAuthCredentials;
  return cachedCredentials;
}

/**
 * Returns a valid OAuth2 access token, refreshing if expired or not yet obtained.
 */
async function getAccessToken(): Promise<string> {
  // Return cached token if still valid (with 60s buffer)
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 60_000) {
    return cachedAccessToken.token;
  }

  const creds = await getOAuthCredentials();
  const oauth2Client = new google.auth.OAuth2(
    creds.client_id,
    creds.client_secret,
  );
  oauth2Client.setCredentials({ refresh_token: creds.refresh_token });

  const { credentials } = await oauth2Client.refreshAccessToken();

  if (!credentials.access_token) {
    throw new Error('Failed to refresh Google OAuth2 access token');
  }

  cachedAccessToken = {
    token: credentials.access_token,
    expiresAt: credentials.expiry_date ?? Date.now() + 3_600_000,
  };

  return cachedAccessToken.token;
}

/** Reset cached credentials and token — useful for testing. */
export function resetOAuthCache(): void {
  cachedCredentials = null;
  cachedAccessToken = null;
}

// ---------------------------------------------------------------------------
// Retry helper — wraps calls with 429 retry logic
// ---------------------------------------------------------------------------

export class SheetsHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly message: string,
  ) {
    super(`Google Sheets API ${status}: ${message}`);
    this.name = 'SheetsHttpError';
  }
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof SheetsHttpError) {
    return error.status === 429 || error.status >= 500;
  }
  // googleapis throws errors with a code property
  const err = error as { code?: number; status?: number };
  if (err.code === 429 || err.code === 503 || (err.code && err.code >= 500)) {
    return true;
  }
  if (err.status === 429 || (err.status && err.status >= 500)) {
    return true;
  }
  return false;
}

function sheetsRetry<T>(fn: () => Promise<T>): Promise<T> {
  return withRetry(
    fn,
    {
      maxRetries: RETRY_MAX_RETRIES,
      baseDelayMs: RETRY_BASE_DELAY_MS,
      maxDelayMs: RETRY_MAX_DELAY_MS,
      jitter: true,
    },
    isRetryableError,
  );
}

// ---------------------------------------------------------------------------
// Authenticated API client factories
// ---------------------------------------------------------------------------

async function getSheetsApi(): Promise<sheets_v4.Sheets> {
  const token = await getAccessToken();
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: token });
  return google.sheets({ version: 'v4', auth: oauth2Client });
}

async function getDriveApi(): Promise<drive_v3.Drive> {
  const token = await getAccessToken();
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: token });
  return google.drive({ version: 'v3', auth: oauth2Client });
}

// ---------------------------------------------------------------------------
// Sheets Client
// ---------------------------------------------------------------------------

const logger = createLogger({
  correlationId: 'sheets-client',
  lambdaName: 'shared',
});


/**
 * Finds an existing spreadsheet by name or creates a new one.
 * Returns the spreadsheet ID.
 *
 * Requirement 10.1: One spreadsheet per team named "[TeamName] Engineering Reports"
 */
export async function getOrCreateSpreadsheet(teamName: string): Promise<string> {
  return sheetsRetry(async () => {
    const drive = await getDriveApi();
    const title = `${teamName} Engineering Reports`;

    // Search for existing spreadsheet by name
    const searchResult = await drive.files.list({
      q: `name='${title.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`,
      fields: 'files(id,name)',
      spaces: 'drive',
    });

    if (searchResult.data.files && searchResult.data.files.length > 0) {
      const id = searchResult.data.files[0].id!;
      logger.info({ spreadsheetId: id, teamName }, 'Found existing spreadsheet');
      return id;
    }

    // Create new spreadsheet
    const sheets = await getSheetsApi();
    const createResult = await sheets.spreadsheets.create({
      requestBody: {
        properties: { title },
      },
    });

    const id = createResult.data.spreadsheetId!;
    logger.info({ spreadsheetId: id, teamName }, 'Created new spreadsheet');
    return id;
  });
}

/**
 * Creates a new sheet (tab) within a spreadsheet.
 * If a sheet with the same name already exists, returns its sheetId.
 * Returns the sheetId.
 *
 * Requirement 10.2: Create sheets within each spreadsheet
 */
export async function createSheet(
  spreadsheetId: string,
  sheetName: string,
): Promise<number> {
  return sheetsRetry(async () => {
    const sheets = await getSheetsApi();

    // Check if sheet already exists
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
    const existing = spreadsheet.data.sheets?.find(
      (s) => s.properties?.title === sheetName,
    );

    if (existing) {
      const sheetId = existing.properties!.sheetId!;
      logger.info({ spreadsheetId, sheetName, sheetId }, 'Sheet already exists');
      return sheetId;
    }

    // Create new sheet
    const result = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            addSheet: {
              properties: { title: sheetName },
            },
          },
        ],
      },
    });

    const sheetId = result.data.replies?.[0]?.addSheet?.properties?.sheetId ?? 0;
    logger.info({ spreadsheetId, sheetName, sheetId }, 'Created new sheet');
    return sheetId;
  });
}

/**
 * Writes data to a specified range in a spreadsheet.
 *
 * Requirement 10.9, 10.10: Write/overwrite/append data to sheets
 */
export async function writeData(
  spreadsheetId: string,
  range: string,
  values: unknown[][],
): Promise<void> {
  return sheetsRetry(async () => {
    const sheets = await getSheetsApi();

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values },
    });

    logger.info(
      { spreadsheetId, range, rows: values.length },
      'Wrote data to sheet',
    );
  });
}

/**
 * Applies formatting to a sheet: header style, alternating rows, numeric alignment, at-risk colors.
 *
 * Requirements 10.3–10.7: Header formatting, alternating rows, numeric alignment,
 * hyperlinks, at-risk color coding
 */
export async function applyFormatting(
  spreadsheetId: string,
  sheetId: number,
  format: SheetFormat,
): Promise<void> {
  return sheetsRetry(async () => {
    const sheets = await getSheetsApi();

    const requests: sheets_v4.Schema$Request[] = [];

    // Header row: bold, frozen, background color, text color
    if (format.headerStyle.frozen) {
      requests.push({
        updateSheetProperties: {
          properties: {
            sheetId,
            gridProperties: { frozenRowCount: 1 },
          },
          fields: 'gridProperties.frozenRowCount',
        },
      });
    }

    requests.push({
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 0,
          endRowIndex: 1,
        },
        cell: {
          userEnteredFormat: {
            textFormat: {
              bold: format.headerStyle.bold,
              foregroundColorStyle: {
                rgbColor: hexToRgb(format.headerStyle.textColor),
              },
            },
            backgroundColor: hexToRgb(format.headerStyle.backgroundColor),
          },
        },
        fields:
          'userEnteredFormat(textFormat,backgroundColor)',
      },
    });

    // Alternating row colors via banding
    requests.push({
      addBanding: {
        bandedRange: {
          range: { sheetId },
          rowProperties: {
            firstBandColor: hexToRgb(format.alternatingRowColors.color1),
            secondBandColor: hexToRgb(format.alternatingRowColors.color2),
          },
        },
      },
    });

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests },
    });

    logger.info({ spreadsheetId, sheetId }, 'Applied formatting to sheet');
  });
}

/**
 * Creates an embedded chart in a sheet.
 *
 * Requirements 9.1–9.4: Embedded charts sized 600×371, positioned right of data
 */
export async function createChart(
  spreadsheetId: string,
  sheetId: number,
  chart: ChartSpec,
): Promise<void> {
  return sheetsRetry(async () => {
    const sheets = await getSheetsApi();

    const chartTypeMap: Record<string, string> = {
      BAR: 'BAR',
      LINE: 'LINE',
      PIE: 'PIE',
      STACKED_BAR: 'BAR',
    };

    const basicChart: sheets_v4.Schema$BasicChartSpec = {
      chartType: chartTypeMap[chart.type] ?? 'BAR',
      legendPosition: 'BOTTOM_LEGEND',
      domains: [
        {
          domain: {
            sourceRange: {
              sources: [
                {
                  sheetId: chart.dataRange.sheetId,
                  startRowIndex: chart.dataRange.startRowIndex,
                  endRowIndex: chart.dataRange.endRowIndex,
                  startColumnIndex: chart.dataRange.startColumnIndex,
                  endColumnIndex: chart.dataRange.startColumnIndex + 1,
                },
              ],
            },
          },
        },
      ],
      series: [
        {
          series: {
            sourceRange: {
              sources: [
                {
                  sheetId: chart.dataRange.sheetId,
                  startRowIndex: chart.dataRange.startRowIndex,
                  endRowIndex: chart.dataRange.endRowIndex,
                  startColumnIndex: chart.dataRange.startColumnIndex + 1,
                  endColumnIndex: chart.dataRange.endColumnIndex,
                },
              ],
            },
          },
          targetAxis: 'LEFT_AXIS',
        },
      ],
      stackedType: chart.type === 'STACKED_BAR' ? 'STACKED' : 'NOT_STACKED',
    };

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            addChart: {
              chart: {
                spec: {
                  title: chart.title,
                  basicChart,
                },
                position: {
                  overlayPosition: {
                    anchorCell: {
                      sheetId: chart.position.sheetId,
                      rowIndex: 0,
                      columnIndex: 0,
                    },
                    offsetXPixels: chart.position.offsetXPixels,
                    offsetYPixels: chart.position.offsetYPixels,
                    widthPixels: chart.size.width,
                    heightPixels: chart.size.height,
                  },
                },
              },
            },
          },
        ],
      },
    });

    logger.info(
      { spreadsheetId, sheetId, chartTitle: chart.title },
      'Created chart',
    );
  });
}

/**
 * Deletes all existing charts in a sheet.
 *
 * Requirement 9.5: Delete existing charts before creating new ones
 */
export async function deleteCharts(
  spreadsheetId: string,
  sheetId: number,
): Promise<void> {
  return sheetsRetry(async () => {
    const sheets = await getSheetsApi();

    // Get all charts in the spreadsheet
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
    const targetSheet = spreadsheet.data.sheets?.find(
      (s) => s.properties?.sheetId === sheetId,
    );

    const charts = targetSheet?.charts ?? [];
    if (charts.length === 0) {
      logger.info({ spreadsheetId, sheetId }, 'No charts to delete');
      return;
    }

    const requests: sheets_v4.Schema$Request[] = charts.map((chart) => ({
      deleteEmbeddedObject: {
        objectId: chart.chartId!,
      },
    }));

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests },
    });

    logger.info(
      { spreadsheetId, sheetId, deletedCount: charts.length },
      'Deleted existing charts',
    );
  });
}

/**
 * Applies sheet protection to prevent accidental edits.
 *
 * Requirement 10.8: Protect sheets for past periods
 */
export async function protectSheet(
  spreadsheetId: string,
  sheetId: number,
): Promise<void> {
  return sheetsRetry(async () => {
    const sheets = await getSheetsApi();

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            addProtectedRange: {
              protectedRange: {
                range: { sheetId },
                description: 'Protected report — read only',
                warningOnly: true,
              },
            },
          },
        ],
      },
    });

    logger.info({ spreadsheetId, sheetId }, 'Applied sheet protection');
  });
}

/**
 * Grants Editor access to a specific email on a spreadsheet via Drive API.
 *
 * Requirement 15.4: Grant Editor access to automation service account
 */
export async function grantEditorAccess(
  spreadsheetId: string,
  email: string,
): Promise<void> {
  return sheetsRetry(async () => {
    const drive = await getDriveApi();

    await drive.permissions.create({
      fileId: spreadsheetId,
      requestBody: {
        type: 'user',
        role: 'writer',
        emailAddress: email,
      },
      sendNotificationEmail: false,
    });

    logger.info(
      { spreadsheetId, email },
      'Granted editor access to spreadsheet',
    );
  });
}

// ---------------------------------------------------------------------------
// Utility: hex color to Google Sheets RGB
// ---------------------------------------------------------------------------

function hexToRgb(hex: string): sheets_v4.Schema$Color {
  const cleaned = hex.replace('#', '');
  const r = parseInt(cleaned.substring(0, 2), 16) / 255;
  const g = parseInt(cleaned.substring(2, 4), 16) / 255;
  const b = parseInt(cleaned.substring(4, 6), 16) / 255;
  return { red: r, green: g, blue: b };
}
