import type { Db } from 'mongodb';

import spacesConfigJson from '../../config/spaces.config.json';
import slaConfigJson from '../../config/sla.config.json';

/**
 * Configurable SLA thresholds used for at-risk task flagging and system behavior.
 */
export interface SlaThresholds {
  inactivity_days: number;
  open_task_days: number;
  rework_count_flag: number;
  backfill_concurrency: number;
  workload_imbalance_pct: number;
}

/**
 * A single space entry in the spaces configuration.
 */
export interface SpaceEntry {
  space_id: string;
  space_name: string;
  include_lists: string[];
  exclude_lists: string[];
}

/**
 * Top-level structure of spaces.config.json.
 */
export interface SpacesConfig {
  spaces: SpaceEntry[];
}

/** Documented defaults per Requirement 20.4 */
export const SLA_DEFAULTS: SlaThresholds = {
  inactivity_days: 3,
  open_task_days: 7,
  rework_count_flag: 2,
  backfill_concurrency: 2,
  workload_imbalance_pct: 35,
};

const SLA_THRESHOLD_KEYS: (keyof SlaThresholds)[] = [
  'inactivity_days',
  'open_task_days',
  'rework_count_flag',
  'backfill_concurrency',
  'workload_imbalance_pct',
];

/**
 * Loads the spaces configuration from the bundled spaces.config.json.
 * Throws if the config is malformed.
 */
export function loadSpacesConfig(): SpacesConfig {
  const parsed = spacesConfigJson as SpacesConfig;

  if (!Array.isArray(parsed.spaces)) {
    throw new Error('spaces.config.json must contain a "spaces" array');
  }

  return parsed;
}

/**
 * Loads SLA thresholds with precedence: MongoDB > bundled file > defaults.
 *
 * - Starts with documented defaults (Req 20.4)
 * - Overlays values from the bundled sla.config.json (Req 20.2)
 * - Overlays values from MongoDB `sla_config` collection when a Db is provided (Req 20.3)
 *
 * @param db Optional MongoDB Db instance. When omitted, only bundled file + defaults are used.
 */
export async function loadSlaConfig(db?: Db): Promise<SlaThresholds> {
  // 1. Start with defaults
  const thresholds: SlaThresholds = { ...SLA_DEFAULTS };

  // 2. Overlay from bundled config file
  try {
    const fileValues = slaConfigJson as Partial<SlaThresholds>;

    for (const key of SLA_THRESHOLD_KEYS) {
      if (typeof fileValues[key] === 'number') {
        thresholds[key] = fileValues[key];
      }
    }
  } catch {
    // Config parse failed — continue with defaults
  }

  // 3. Overlay from MongoDB (highest precedence, Req 20.3)
  if (db) {
    try {
      const docs = await db
        .collection<{ key: string; value: number }>('sla_config')
        .find({})
        .toArray();

      for (const doc of docs) {
        if (SLA_THRESHOLD_KEYS.includes(doc.key as keyof SlaThresholds) && typeof doc.value === 'number') {
          thresholds[doc.key as keyof SlaThresholds] = doc.value;
        }
      }
    } catch {
      // MongoDB read failed — continue with file/default values
    }
  }

  return thresholds;
}
