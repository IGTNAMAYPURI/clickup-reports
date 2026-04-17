/**
 * Centralized CloudWatch metrics emission utility.
 *
 * Provides reusable functions for emitting custom CloudWatch metrics
 * under the `ClickUpReporting` namespace. All Lambda handlers should
 * use these functions instead of inline metric emission.
 *
 * Requirements: 18.2
 */

import {
  CloudWatchClient,
  PutMetricDataCommand,
  type MetricDatum,
  type StandardUnit,
} from '@aws-sdk/client-cloudwatch';
import { getAwsClientConfig } from '@src/utils/aws-client.config';

const NAMESPACE = 'ClickUpReporting';
const client = new CloudWatchClient(getAwsClientConfig());

/**
 * Emits a single custom CloudWatch metric.
 *
 * @param name  - The metric name (e.g. `ReportGenerationDurationMs`)
 * @param value - The metric value
 * @param unit  - The CloudWatch unit (e.g. `Milliseconds`, `Count`)
 */
export async function emitMetric(
  name: string,
  value: number,
  unit: StandardUnit,
): Promise<void> {
  const datum: MetricDatum = {
    MetricName: name,
    Value: value,
    Unit: unit,
    Timestamp: new Date(),
  };

  await client.send(
    new PutMetricDataCommand({
      Namespace: NAMESPACE,
      MetricData: [datum],
    }),
  );
}

/**
 * Emits the `ReportGenerationDurationMs` metric.
 */
export async function emitReportDuration(durationMs: number): Promise<void> {
  await emitMetric('ReportGenerationDurationMs', durationMs, 'Milliseconds');
}

/**
 * Emits the `TasksFetched` metric.
 */
export async function emitTasksFetched(count: number): Promise<void> {
  await emitMetric('TasksFetched', count, 'Count');
}

/**
 * Emits the `SheetsRowsWritten` metric.
 */
export async function emitSheetsRowsWritten(count: number): Promise<void> {
  await emitMetric('SheetsRowsWritten', count, 'Count');
}

/**
 * Emits the `ChartsCreated` metric.
 */
export async function emitChartsCreated(count: number): Promise<void> {
  await emitMetric('ChartsCreated', count, 'Count');
}
