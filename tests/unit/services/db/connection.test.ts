import {
  getClient,
  getDb,
  closeConnection,
  _resetForTesting,
} from '@src/services/db/connection';

/* ------------------------------------------------------------------ */
/*  Mocks                                                              */
/* ------------------------------------------------------------------ */

// Mock the retry utility to avoid real delays in tests
jest.mock('@src/utils/retry', () => ({
  withRetry: jest.fn(async (fn: () => Promise<unknown>) => fn()),
}));

// Mock the logger
jest.mock('@src/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  }),
}));

const mockConnect = jest.fn().mockResolvedValue(undefined);
const mockClose = jest.fn().mockResolvedValue(undefined);
const mockDb = jest.fn().mockReturnValue({ databaseName: 'clickup_reporting' });

jest.mock('mongodb', () => ({
  MongoClient: jest.fn().mockImplementation(() => ({
    connect: mockConnect,
    close: mockClose,
    db: mockDb,
  })),
}));

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn().mockImplementation(() => ({
    send: mockSend,
  })),
  GetSecretValueCommand: jest.fn().mockImplementation((input: unknown) => input),
}));

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const FAKE_URI = 'mongodb+srv://user:pass@cluster.mongodb.net/test';

function setupSecretResponse(secretString?: string) {
  mockSend.mockResolvedValue({ SecretString: secretString });
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

beforeEach(() => {
  _resetForTesting();
  jest.clearAllMocks();
  setupSecretResponse(FAKE_URI);
});

describe('getClient', () => {
  it('fetches the connection string from Secrets Manager and connects', async () => {
    const client = await getClient();

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(client).toBeDefined();
    expect(client.connect).toBeDefined();
  });

  it('reuses the cached client on subsequent calls', async () => {
    const first = await getClient();
    const second = await getClient();

    expect(first).toBe(second);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  it('throws when SecretString is empty', async () => {
    setupSecretResponse(undefined);

    await expect(getClient()).rejects.toThrow('has no SecretString value');
  });

  it('uses withRetry for the connection attempt', async () => {
    const { withRetry } = require('@src/utils/retry');
    await getClient();

    expect(withRetry).toHaveBeenCalledTimes(1);
    expect(withRetry).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        maxRetries: 3,
        baseDelayMs: 500,
        maxDelayMs: 5000,
        jitter: true,
      }),
    );
  });
});

describe('getDb', () => {
  it('returns a Db instance from the cached client', async () => {
    const db = await getDb();

    expect(db).toBeDefined();
    expect(mockDb).toHaveBeenCalledWith('clickup_reporting');
  });

  it('reuses the same client for multiple getDb calls', async () => {
    await getDb();
    await getDb();

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockDb).toHaveBeenCalledTimes(2);
  });
});

describe('closeConnection', () => {
  it('closes the client and clears the cache', async () => {
    await getClient();
    await closeConnection();

    expect(mockClose).toHaveBeenCalledTimes(1);

    // After closing, a new call should create a fresh client
    await getClient();
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockConnect).toHaveBeenCalledTimes(2);
  });

  it('is a no-op when no connection exists', async () => {
    await closeConnection();
    expect(mockClose).not.toHaveBeenCalled();
  });
});

describe('_resetForTesting', () => {
  it('clears the cache without closing the connection', async () => {
    await getClient();
    _resetForTesting();

    expect(mockClose).not.toHaveBeenCalled();

    // Next call should create a new client
    await getClient();
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockConnect).toHaveBeenCalledTimes(2);
  });
});
