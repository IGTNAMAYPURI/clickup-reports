/**
 * Unit tests for src/utils/metrics.ts
 *
 * Validates that each metric emission function sends the correct
 * metric name, value, unit, and namespace to CloudWatch.
 *
 * Requirements: 18.2
 */

const sendMock = jest.fn().mockResolvedValue({});

jest.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: jest.fn().mockImplementation(() => ({ send: sendMock })),
  PutMetricDataCommand: jest.fn().mockImplementation((input) => input),
}));

import { PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import {
  emitMetric,
  emitReportDuration,
  emitTasksFetched,
  emitSheetsRowsWritten,
  emitChartsCreated,
} from '@src/utils/metrics';

describe('metrics utility', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('emitMetric', () => {
    it('should send a PutMetricDataCommand with correct namespace and datum', async () => {
      await emitMetric('TestMetric', 42, 'Count');

      expect(PutMetricDataCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          Namespace: 'ClickUpReporting',
          MetricData: [
            expect.objectContaining({
              MetricName: 'TestMetric',
              Value: 42,
              Unit: 'Count',
              Timestamp: expect.any(Date),
            }),
          ],
        }),
      );
      expect(sendMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('emitReportDuration', () => {
    it('should emit ReportGenerationDurationMs in Milliseconds', async () => {
      await emitReportDuration(1500);

      expect(PutMetricDataCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          Namespace: 'ClickUpReporting',
          MetricData: [
            expect.objectContaining({
              MetricName: 'ReportGenerationDurationMs',
              Value: 1500,
              Unit: 'Milliseconds',
            }),
          ],
        }),
      );
      expect(sendMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('emitTasksFetched', () => {
    it('should emit TasksFetched in Count', async () => {
      await emitTasksFetched(200);

      expect(PutMetricDataCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          Namespace: 'ClickUpReporting',
          MetricData: [
            expect.objectContaining({
              MetricName: 'TasksFetched',
              Value: 200,
              Unit: 'Count',
            }),
          ],
        }),
      );
      expect(sendMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('emitSheetsRowsWritten', () => {
    it('should emit SheetsRowsWritten in Count', async () => {
      await emitSheetsRowsWritten(350);

      expect(PutMetricDataCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          Namespace: 'ClickUpReporting',
          MetricData: [
            expect.objectContaining({
              MetricName: 'SheetsRowsWritten',
              Value: 350,
              Unit: 'Count',
            }),
          ],
        }),
      );
      expect(sendMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('emitChartsCreated', () => {
    it('should emit ChartsCreated in Count', async () => {
      await emitChartsCreated(4);

      expect(PutMetricDataCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          Namespace: 'ClickUpReporting',
          MetricData: [
            expect.objectContaining({
              MetricName: 'ChartsCreated',
              Value: 4,
              Unit: 'Count',
            }),
          ],
        }),
      );
      expect(sendMock).toHaveBeenCalledTimes(1);
    });
  });
});
