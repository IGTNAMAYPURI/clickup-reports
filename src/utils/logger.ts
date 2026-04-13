import pino from 'pino';

/**
 * Creates a Pino logger with structured JSON output and contextual base fields.
 * All log entries include the correlationId and lambdaName for end-to-end tracing.
 * No PII is included in log output by design — callers must avoid passing PII in messages.
 */
export function createLogger(context: {
  correlationId: string;
  lambdaName: string;
}): pino.Logger {
  return pino({
    level: process.env.LOG_LEVEL ?? 'info',
    base: {
      correlationId: context.correlationId,
      lambdaName: context.lambdaName,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        return { level: label };
      },
    },
  });
}
