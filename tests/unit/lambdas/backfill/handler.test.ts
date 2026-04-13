/**
 * Unit tests for the Backfill Lambda handler.
 *
 * Tests cover:
 * - API key validation (Req 6.4, 6.6)
 * - Request body validation (Req 6.1, 6.5)
 * - HTTP 400 for invalid input
 * - HTTP 401 for missing/invalid API key
 * - Period enumeration and skip logic (Req 6.2, 6.7)
 * - Controlled concurrency processing (Req 6.3)
 * - Successful backfill (Req 6.1, 6.8)
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
import { handler, _resetApiKeyCacheForTesting } from '@src/lambdas/backfill/handler';
import { getDb } from '@src/services/db/connection';

const mockGetDb = getDb as jest.MockedFunction<typeof getDb>;

function buildEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    path: '/reports/backfill',
    headers: { 'x-api-key': 'test-api-key' },
    body: JSON.stringify({
      from_date: '2024-01-01T00:00:00.000Z',
      to_date: '2024-01-03T23:59:59.999Z',
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

function setupMockDb(options: { existingReports?: boolean } = {}) {
  const mockToArray = jest.fn().mockResolvedValue([]);
  const mockFind = jest.fn().mockReturnValue({ toArray: mockToArray });
  const mockCountDocuments = jest.fn().mockResolvedValue(options.existingReports ? 1 : 0);
  const mockInsertOne = jest.fn().mockResolvedValue({ insertedId: 'test-id' });

  const mockCollection = jest.fn().mockImplementation((name: string) => {
    if (name === 'report_snapshots') {
      return {
        find: mockFind,
        countDocuments: mockCountDocuments,
        insertOne: mockInsertOne,
      };
    }
    return {
      find: mockFind,
      countDocuments: mockCountDocuments,
      insertOne: mockInsertOne,
    };
  });

  const mockDb = { collection: mockCollection };
  mockGetDb.mockResolvedValue(mockDb as any);
  return { mockDb, mockCountDocuments, mockInsertOne };
}

describe('Backfill Lambda handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    _resetApiKeyCacheForTesting();
    process.env = { ...originalEnv, API_KEY: 'test-api-key' };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('API key validation (Req 6.4, 6.6)', () => {
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

  describe('Request body validation (Req 6.1, 6.5)', () => {
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

    it('should return 400 when from_date is missing', async () => {
      const event = buildEvent({
        body: JSON.stringify({ to_date: '2024-01-03T23:59:59.999Z' }),
      });
      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.error).toContain('from_date');
    });

    it('should return 400 when from_date is not a valid date', async () => {
      const event = buildEvent({
        body: JSON.stringify({
          from_date: 'not-a-date',
          to_date: '2024-01-03T23:59:59.999Z',
        }),
      });
      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.error).toContain('Invalid from_date');
    });

    it('should return 400 when to_date is missing', async () => {
      const event = buildEvent({
        body: JSON.stringify({ from_date: '2024-01-01T00:00:00.000Z' }),
      });
      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.error).toContain('to_date');
    });

    it('should return 400 when to_date is not a valid date', async () => {
      const event = buildEvent({
        body: JSON.stringify({
          from_date: '2024-01-01T00:00:00.000Z',
          to_date: 'invalid',
        }),
      });
      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.error).toContain('Invalid to_date');
    });

    it('should return 400 when from_date is after to_date', async () => {
      const event = buildEvent({
        body: JSON.stringify({
          from_date: '2024-01-10T00:00:00.000Z',
          to_date: '2024-01-01T23:59:59.999Z',
        }),
      });
      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.error).toContain('from_date must be before');
    });
  });

  describe('Backfill processing (Req 6.2, 6.3, 6.7)', () => {
    it('should return 200 on successful backfill', async () => {
      setupMockDb();
      const event = buildEvent();
      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('Backfill completed');
      expect(body.from_date).toBe('2024-01-01T00:00:00.000Z');
      expect(body.to_date).toBe('2024-01-03T23:59:59.999Z');
      expect(body.total_periods).toBeGreaterThan(0);
    });

    it('should skip periods with existing reports (Req 6.7)', async () => {
      setupMockDb({ existingReports: true });
      const event = buildEvent();
      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.skipped).toBeGreaterThan(0);
      expect(body.processed).toBe(0);
    });

    it('should return 500 when MongoDB connection fails', async () => {
      mockGetDb.mockRejectedValue(new Error('Connection failed'));

      const event = buildEvent();
      const result = await handler(event);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.error).toContain('Internal server error');
    });

    it('should handle single-day range', async () => {
      setupMockDb();
      const event = buildEvent({
        body: JSON.stringify({
          from_date: '2024-01-15T00:00:00.000Z',
          to_date: '2024-01-15T23:59:59.999Z',
        }),
      });
      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      // At minimum: 1 daily + 1 weekly + 1 monthly period
      expect(body.total_periods).toBeGreaterThanOrEqual(1);
    });
  });
});
