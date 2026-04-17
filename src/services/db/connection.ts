/**
 * MongoDB connection pool manager.
 *
 * Caches a single MongoClient instance so it is reused across warm Lambda
 * invocations (Req 14.4). The connection string is fetched from AWS Secrets
 * Manager on the first (cold-start) call (Req 14.5). Connection attempts
 * are retried up to 3 times via the shared withRetry utility.
 */

import { MongoClient, Db } from 'mongodb';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { withRetry } from '@src/utils/retry';
import { createLogger } from '@src/utils/logger';
import { getAwsClientConfig } from '@src/utils/aws-client.config';

const logger = createLogger({
  correlationId: 'db-pool',
  lambdaName: 'shared-layer',
});

const SECRET_NAME =
  process.env.MONGODB_SECRET_NAME ?? 'clickup-reporting/mongodb-uri';
const DB_NAME = process.env.MONGODB_DB_NAME ?? 'clickup_reporting';

let cachedClient: MongoClient | null = null;
let cachedConnectionString: string | null = null;

/**
 * Retrieves the MongoDB connection string from Secrets Manager.
 * The value is cached for the lifetime of the Lambda execution environment.
 */
async function getConnectionString(
  secretsClient: SecretsManagerClient = new SecretsManagerClient(getAwsClientConfig()),
): Promise<string> {
  if (cachedConnectionString) {
    return cachedConnectionString;
  }

  logger.info({ secretName: SECRET_NAME }, 'Fetching MongoDB URI from Secrets Manager');

  const command = new GetSecretValueCommand({ SecretId: SECRET_NAME });
  const response = await secretsClient.send(command);

  if (!response.SecretString) {
    throw new Error(`Secret "${SECRET_NAME}" has no SecretString value`);
  }

  cachedConnectionString = response.SecretString;
  return cachedConnectionString;
}

/**
 * Returns a connected MongoClient, creating one on the first call.
 * The client is cached and reused across warm Lambda invocations.
 * Retries connection up to 3 times on failure.
 */
export async function getClient(
  secretsClient?: SecretsManagerClient,
): Promise<MongoClient> {
  if (cachedClient) {
    return cachedClient;
  }

  const uri = await getConnectionString(secretsClient);

  const client = await withRetry(
    async () => {
      const c = new MongoClient(uri);
      await c.connect();
      return c;
    },
    { maxRetries: 3, baseDelayMs: 500, maxDelayMs: 5000, jitter: true },
  );

  logger.info('MongoDB connection established');
  cachedClient = client;
  return client;
}

/**
 * Returns the default Db instance from the cached MongoClient.
 */
export async function getDb(
  secretsClient?: SecretsManagerClient,
): Promise<Db> {
  const client = await getClient(secretsClient);
  return client.db(DB_NAME);
}

/**
 * Closes the cached connection and clears the cache.
 * Useful for cleanup in tests and graceful shutdown.
 */
export async function closeConnection(): Promise<void> {
  if (cachedClient) {
    await cachedClient.close();
    cachedClient = null;
    cachedConnectionString = null;
    logger.info('MongoDB connection closed');
  }
}

/**
 * Resets the module-level cache without closing the connection.
 * Intended for test isolation only.
 * @internal
 */
export function _resetForTesting(): void {
  cachedClient = null;
  cachedConnectionString = null;
}
