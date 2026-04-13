/**
 * Unit tests for the Manual Trigger Lambda handler.
 *
 * Tests cover:
 * - API key validation (Req 5.3, 5.5)
 * - Request body validation (Req 5.1, 5.4)
 * - HTTP 400 for invalid input
 * - HTTP 401 for missing/invalid API key
 * - Successful delegation to report generation (Req 5.2)
 */

// Mock AWS SDK clients before any imports
jest.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockResolvedValue({}),
  })),
  PutMetricDataCommand: jest.fn(),
}));

jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockResolvedValue({ SecretString: 'test-api-key' }),
  })),
  GetSecretValueCommand: jest.fn(),
}));

jest.mock('@src/services/db/connection');
jest.mock('@src/services/reports/builder');
jest.mock('@src/services/reports/chart-builder');
jest.mock('@src/services/sheets/client');
jest.mock('@src/services/sheets/formatter', () => ({
  DEFAULT_SHEET_FORMAT: {},
  formatTaskBreakdownData: jest.fn().mockReturnValue({
    headers: ['col1'],
    formattedRows: [],
  }),
}));

import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler, _resetApiKeyCacheForTesting } from '@src/lambdas/manual-trigger/handler';
import { getDb } from '@src/services/db/connection';

const mockGetDb = getDb as jest.MockedFunction<typeof getDb>;

function buildEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    path: '/reports/generate',
    headers: { 'x-api-key': 'test-api-key' },
    body: JSON.stringify({
      report_type: 'daily',
      period_start: '2024-01-15T00:00:00.000Z',
      period_end: '2024-01-15T23:59:59.999Z',
    }),
    queryStringParameters: null,
    pathParameters: null,
    stageVariables: null,
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    isBase64Encoded: false,
    requestContext: {} as APIGatewayProxyEvent['requestContext'],
    resource: '',
    ...overrides,
  };
}

describe('Manual Trigger Lambda handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    _resetApiKeyCacheForTesting();
    process.env = { ...originalEnv, API_KEY: 'test-api-key' };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('API key validation (Req 5.3, 5.5)', () => {
    it('should return 401 when x-api-key header is missing', async () => {
      const event = buildEvent({ headers: {} });
      const result = await handler(event);

      expect(result.statusCode).toBe(401);
      const body = JSON.parse(result.body);
      expect(body.error).toContain('Missing API key');
    });

    it('should return 401 when API key is invalid', async () => {
      const event = buildEvent({ headers: { 'x-api-key': 'wrong-key' } });
      const result = await handler(event);

      expect(result.statusCode).toBe(401);
      const body = JSON.parse(result.body);
      expect(body.error).toContain('Invalid API key');
    });

    it('should accept API key from X-Api-Key header', async () => {
      const event = buildEvent({
        headers: { 'X-Api-Key': 'test-api-key' },
        body: null,
      });
      const result = await handler(event);

      // Should pass auth but fail on body validation (400, not 401)
      expect(result.statusCode).toBe(400);
    });
  });

  describe('Request body validation (Req 5.1, 5.4)', () => {
    it('should return 400 when body is null', async () => {
      const event = buildEvent({ body: null });
      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.error).toContain('Request body is required');
    });

    it('should return 400 when body is not valid JSON', async () => {
      const event = buildEvent({ body: 'not-json' });
      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.error).toContain('valid JSON');
    });

    it('should return 400 when report_type is missing', async () => {
      const event = buildEvent({
        body: JSON.stringify({
          period_start: '2024-01-15T00:00:00.000Z',
          period_end: '2024-01-15T23:59:59.999Z',
        }),
      });
      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.error).toContain('report_type');
    });

    it('should return 400 when report_type is invalid', async () => {
      const event = buildEvent({
        body: JSON.stringify({
          report_type: 'yearly',
          period_start: '2024-01-15T00:00:00.000Z',
          period_end: '2024-01-15T23:59:59.999Z',
        }),
      });
      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.error).toContain('Invalid report_type');
    });

    it('should return 400 when period_start is missing', async () => {
      const event = buildEvent({
        body: JSON.stringify({
          report_type: 'daily',
          period_end: '2024-01-15T23:59:59.999Z',
        }),
      });
      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.error).toContain('period_start');
    });

    it('should return 400 when period_start is not a valid date', async () => {
      const event = buildEvent({
        body: JSON.stringify({
          report_type: 'daily',
          period_start: 'not-a-date',
          period_end: '2024-01-15T23:59:59.999Z',
        }),
      });
      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.error).toContain('Invalid period_start');
    });

    it('should return 400 when period_end is missing', async () => {
      const event = buildEvent({
        body: JSON.stringify({
          report_type: 'daily',
          period_start: '2024-01-15T00:00:00.000Z',
        }),
      });
      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.error).toContain('period_end');
    });

    it('should return 400 when period_end is not a valid date', async () => {
      const event = buildEvent({
        body: JSON.stringify({
          report_type: 'daily',
          period_start: '2024-01-15T00:00:00.000Z',
          period_end: 'invalid',
        }),
      });
      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.error).toContain('Invalid period_end');
    });

    it('should return 400 when period_start is after period_end', async () => {
      const event = buildEvent({
        body: JSON.stringify({
          report_type: 'daily',
          period_start: '2024-01-16T00:00:00.000Z',
          period_end: '2024-01-15T23:59:59.999Z',
        }),
      });
      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.error).toContain('period_start must be before');
    });
  });

  describe('Report generation (Req 5.2)', () => {
    function setupMockDb() {
      const mockCollection = {
        find: jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue([]) }),
        insertOne: jest.fn().mockResolvedValue({ insertedId: 'test-id' }),
      };
      const mockDb = { collection: jest.fn().mockReturnValue(mockCollection) };
      mockGetDb.mockResolvedValue(mockDb as any);
      return mockDb;
    }

    it('should return 200 on successful report generation', async () => {
      setupMockDb();
      const event = buildEvent();
      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('Report generated successfully');
      expect(body.report_type).toBe('daily');
      expect(body.status).toBe('success');
    });

    it('should return 500 when MongoDB connection fails', async () => {
      mockGetDb.mockRejectedValue(new Error('Connection failed'));

      const event = buildEvent();
      const result = await handler(event);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.error).toContain('Internal server error');
    });

    it('should accept weekly report_type', async () => {
      setupMockDb();
      const event = buildEvent({
        body: JSON.stringify({
          report_type: 'weekly',
          period_start: '2024-01-08T00:00:00.000Z',
          period_end: '2024-01-14T23:59:59.999Z',
        }),
      });
      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.report_type).toBe('weekly');
    });

    it('should accept monthly report_type', async () => {
      setupMockDb();
      const event = buildEvent({
        body: JSON.stringify({
          report_type: 'monthly',
          period_start: '2024-01-01T00:00:00.000Z',
          period_end: '2024-01-31T23:59:59.999Z',
        }),
      });
      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.report_type).toBe('monthly');
    });
  });
});
