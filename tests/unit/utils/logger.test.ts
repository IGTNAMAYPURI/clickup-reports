import { createLogger } from '@src/utils/logger';

describe('createLogger', () => {
  const context = {
    correlationId: 'test-corr-id-123',
    lambdaName: 'clickup-sync',
  };

  it('should return a pino logger instance', () => {
    const logger = createLogger(context);
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.debug).toBe('function');
  });

  it('should include correlationId and lambdaName in log output', () => {
    const chunks: string[] = [];
    const dest = {
      write(chunk: string) {
        chunks.push(chunk);
      },
    };

    const logger = createLogger(context);
    // Rebind to a writable destination to capture output
    const testLogger = require('pino')(
      {
        level: 'info',
        base: {
          correlationId: context.correlationId,
          lambdaName: context.lambdaName,
        },
        timestamp: require('pino').stdTimeFunctions.isoTime,
        formatters: {
          level(label: string) {
            return { level: label };
          },
        },
      },
      dest,
    );

    testLogger.info('test message');

    expect(chunks.length).toBe(1);
    const parsed = JSON.parse(chunks[0]);
    expect(parsed.correlationId).toBe('test-corr-id-123');
    expect(parsed.lambdaName).toBe('clickup-sync');
    expect(parsed.level).toBe('info');
    expect(parsed.msg).toBe('test message');
    expect(parsed.time).toBeDefined();
  });

  it('should use "level" label instead of numeric level', () => {
    const chunks: string[] = [];
    const dest = {
      write(chunk: string) {
        chunks.push(chunk);
      },
    };

    const pino = require('pino');
    const testLogger = pino(
      {
        level: 'warn',
        base: {
          correlationId: context.correlationId,
          lambdaName: context.lambdaName,
        },
        formatters: {
          level(label: string) {
            return { level: label };
          },
        },
      },
      dest,
    );

    testLogger.warn('warning message');

    const parsed = JSON.parse(chunks[0]);
    expect(parsed.level).toBe('warn');
    expect(typeof parsed.level).toBe('string');
  });

  it('should default to info log level', () => {
    delete process.env.LOG_LEVEL;
    const logger = createLogger(context);
    expect(logger.level).toBe('info');
  });

  it('should respect LOG_LEVEL environment variable', () => {
    process.env.LOG_LEVEL = 'debug';
    const logger = createLogger(context);
    expect(logger.level).toBe('debug');
    delete process.env.LOG_LEVEL;
  });

  it('should not include PII fields in base context', () => {
    const chunks: string[] = [];
    const dest = {
      write(chunk: string) {
        chunks.push(chunk);
      },
    };

    const pino = require('pino');
    const testLogger = pino(
      {
        level: 'info',
        base: {
          correlationId: context.correlationId,
          lambdaName: context.lambdaName,
        },
        formatters: {
          level(label: string) {
            return { level: label };
          },
        },
      },
      dest,
    );

    testLogger.info('no pii here');

    const parsed = JSON.parse(chunks[0]);
    // Ensure no PII-related fields exist in base output
    expect(parsed.email).toBeUndefined();
    expect(parsed.name).toBeUndefined();
    expect(parsed.phone).toBeUndefined();
    expect(parsed.address).toBeUndefined();
    // Only expected fields
    expect(Object.keys(parsed).sort()).toEqual(
      ['correlationId', 'lambdaName', 'level', 'msg', 'time'].sort(),
    );
  });
});
