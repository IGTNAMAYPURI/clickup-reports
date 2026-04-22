const mockSlaValues: Record<string, unknown> = {};

jest.mock('../../../config/sla.config.json', () => mockSlaValues, { virtual: true });

jest.mock('../../../config/spaces.config.json', () => ({
  spaces: [
    {
      space_id: 'sp1',
      space_name: 'Engineering',
      include_lists: ['list1'],
      exclude_lists: [],
    },
  ],
}), { virtual: true });

import {
  loadSpacesConfig,
  loadSlaConfig,
  SLA_DEFAULTS,
} from '@src/config/config';

describe('loadSpacesConfig', () => {
  it('should parse a valid spaces config', () => {
    const config = loadSpacesConfig();

    expect(config.spaces).toHaveLength(1);
    expect(config.spaces[0].space_id).toBe('sp1');
    expect(config.spaces[0].include_lists).toEqual(['list1']);
  });
});

describe('loadSlaConfig', () => {
  beforeEach(() => {
    // Clear all keys from the shared mock object
    for (const key of Object.keys(mockSlaValues)) {
      delete mockSlaValues[key];
    }
  });

  it('should return defaults when bundled config is empty and no db', async () => {
    const result = await loadSlaConfig();

    expect(result).toEqual(SLA_DEFAULTS);
  });

  it('should overlay bundled file values over defaults', async () => {
    Object.assign(mockSlaValues, { inactivity_days: 5, open_task_days: 14 });

    const result = await loadSlaConfig();

    expect(result.inactivity_days).toBe(5);
    expect(result.open_task_days).toBe(14);
    expect(result.rework_count_flag).toBe(SLA_DEFAULTS.rework_count_flag);
    expect(result.backfill_concurrency).toBe(SLA_DEFAULTS.backfill_concurrency);
    expect(result.workload_imbalance_pct).toBe(SLA_DEFAULTS.workload_imbalance_pct);
  });

  it('should ignore non-numeric file values', async () => {
    Object.assign(mockSlaValues, { inactivity_days: 'not_a_number', open_task_days: 10 });

    const result = await loadSlaConfig();

    expect(result.inactivity_days).toBe(SLA_DEFAULTS.inactivity_days);
    expect(result.open_task_days).toBe(10);
  });

  it('should overlay MongoDB values over file values (Req 20.3)', async () => {
    Object.assign(mockSlaValues, { inactivity_days: 5 });

    const mockDb = {
      collection: jest.fn().mockReturnValue({
        find: jest.fn().mockReturnValue({
          toArray: jest.fn().mockResolvedValue([
            { key: 'inactivity_days', value: 10 },
          ]),
        }),
      }),
    };

    const result = await loadSlaConfig(mockDb as any);

    expect(result.inactivity_days).toBe(10); // MongoDB wins
  });

  it('should apply all MongoDB overrides', async () => {
    const mockDb = {
      collection: jest.fn().mockReturnValue({
        find: jest.fn().mockReturnValue({
          toArray: jest.fn().mockResolvedValue([
            { key: 'inactivity_days', value: 1 },
            { key: 'open_task_days', value: 2 },
            { key: 'rework_count_flag', value: 3 },
            { key: 'backfill_concurrency', value: 4 },
            { key: 'workload_imbalance_pct', value: 50 },
          ]),
        }),
      }),
    };

    const result = await loadSlaConfig(mockDb as any);

    expect(result).toEqual({
      inactivity_days: 1,
      open_task_days: 2,
      rework_count_flag: 3,
      backfill_concurrency: 4,
      workload_imbalance_pct: 50,
    });
  });

  it('should ignore unknown keys from MongoDB', async () => {
    const mockDb = {
      collection: jest.fn().mockReturnValue({
        find: jest.fn().mockReturnValue({
          toArray: jest.fn().mockResolvedValue([
            { key: 'unknown_key', value: 999 },
          ]),
        }),
      }),
    };

    const result = await loadSlaConfig(mockDb as any);

    expect(result).toEqual(SLA_DEFAULTS);
  });

  it('should fall back to defaults when MongoDB read fails', async () => {
    Object.assign(mockSlaValues, { inactivity_days: 5 });

    const mockDb = {
      collection: jest.fn().mockReturnValue({
        find: jest.fn().mockReturnValue({
          toArray: jest.fn().mockRejectedValue(new Error('connection failed')),
        }),
      }),
    };

    const result = await loadSlaConfig(mockDb as any);

    expect(result.inactivity_days).toBe(5); // bundled value preserved
    expect(result.open_task_days).toBe(SLA_DEFAULTS.open_task_days);
  });
});
