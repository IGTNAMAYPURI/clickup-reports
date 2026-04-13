import pino from 'pino';

import { NormalizedStatus } from '@src/types/report';

/**
 * Mapping of known ClickUp statuses to normalized categories.
 *
 * Requirements 12.1–12.4:
 *  - TO DO, BUG FOUND → not_started
 *  - IN PROGRESS, PULL REQUEST → active
 *  - COMPLETE, TESTING → done_in_qa
 *  - DONE → closed_completed
 */
const STATUS_MAP: Record<string, NormalizedStatus> = {
  'TO DO': 'not_started',
  'BUG FOUND': 'not_started',
  'IN PROGRESS': 'active',
  'PULL REQUEST': 'active',
  'COMPLETE': 'done_in_qa',
  'TESTING': 'done_in_qa',
  'DONE': 'closed_completed',
};

/**
 * Classifies a raw ClickUp status string into a NormalizedStatus.
 * Unknown statuses default to `not_started` with a warning log (Req 12.5).
 */
export function classify(clickUpStatus: string, logger?: pino.Logger): NormalizedStatus {
  const upper = clickUpStatus.toUpperCase().trim();
  const mapped = STATUS_MAP[upper];

  if (mapped) {
    return mapped;
  }

  if (logger) {
    logger.warn({ unknownStatus: clickUpStatus }, 'Unknown ClickUp status, defaulting to not_started');
  }

  return 'not_started';
}

/**
 * Returns a copy of the full status mapping for inspection/testing.
 */
export function getStatusMapping(): Record<string, NormalizedStatus> {
  return { ...STATUS_MAP };
}
