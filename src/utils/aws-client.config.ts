/**
 * AWS SDK client configuration utility for LocalStack support.
 *
 * When AWS_ENDPOINT_URL is set (local development), returns config
 * that routes all SDK calls to LocalStack. In deployed environments
 * the env var is absent, so this returns an empty object and the SDK
 * uses its default credential chain.
 */

interface AwsClientConfig {
  endpoint?: string;
  region?: string;
  credentials?: { accessKeyId: string; secretAccessKey: string };
}

/**
 * Returns AWS SDK client config targeting LocalStack when
 * AWS_ENDPOINT_URL is set, or empty config for production.
 */
export function getAwsClientConfig(): AwsClientConfig {
  const endpoint = process.env.AWS_ENDPOINT_URL;
  if (!endpoint) return {};

  return {
    endpoint,
    region: process.env.AWS_REGION ?? 'us-east-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  };
}
