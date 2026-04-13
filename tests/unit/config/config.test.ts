import * as fs from 'fs';
import * as path from 'path';
import {
  loadSpacesConfig,
  loadSlaConfig,
  SLA_DEFAULTS,
  SlaThresholds,
} from '@src/config/config';

// Mock fs.readFileSync
jest.mock('fs');
const mockReadFileSync = fs.readFileSync as jest.MockedFunction<typeof fs.readFileSync>;

describe('loadSpacesConfig', () => {
  afterEach(() => jest.restoreAllMocks());

  it('should parse a valid spaces.config.json', () => {
    const spacesJson = JSON.stringify({
      spaces: [
        {
          space_id: 'sp1',
          space_name: 'Engineering',
          include_lists: ['list1'],
          exclude_lists: [],
        },
      ],
    });
    mockReadFileSync.mockReturnValue(spacesJson);

    const config = loadSpacesConfig();

    expect(config.spaces).toHaveLength(1);
    expect(config.spaces[0].space_id).toBe('sp1');
    expect(config.spaces[0].include_lists).toEqual(['list1']);
  });

  it('should throw when spaces key is missing', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ other: true }));

    expect(() => loadSpacesConfig()).toThrow('spaces.config.json must contain a "spaces" array');
  });

  it('should throw when file is missing', () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    expect(() => loadSpacesConfig()).toThrow();
  });
});

describe('loadSlaConfig', () => {
  afterEach(() => jest.restoreAllMocks());

  it('should return defaults when no file and no db', async () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const result = await loadSlaConfig();

    expect(result).toEqual(SLA_DEFAULTS);
  });

  it('should overlay file values over defaults', async () => {
    const fileConfig = { inactivity_days: 5, open_task_days: 14 };
    mockReadFileSync.mockReturnValue(JSON.stringify(fileConfig));

    const result = await loadSlaConfig();

    expect(result.inactivity_days).toBe(5);
    expect(result.open_task_days).toBe(14);
    // Remaining keys stay at defaults
    expect(result.rework_count_flag).toBe(SLA_DEFAULTS.rework_count_flag);
    expect(result.backfill_concurrency).toBe(SLA_DEFAULTS.backfill_concurrency);
    expect(result.workload_imbalance_pct).toBe(SLA_DEFAULTS.workload_imbalance_pct);
  });

  it('should ignore non-numeric file values', async () => {
    const fileConfig = { inactivity_days: 'not_a_number', open_task_days: 10 };
    mockReadFileSync.mockReturnValue(JSON.stringify(fileConfig));

    const result = await loadSlaConfig();

    expect(result.inactivity_days).toBe(SLA_DEFAULTS.inactivity_days);
    expect(result.open_task_days).toBe(10);
  });

  it('should overlay MongoDB values over file values (Req 20.3)', async () => {
    // File sets inactivity_days=5
    mockReadFileSync.mockReturnValue(JSON.stringify({ inactivity_days: 5 }));

    // MongoDB sets inactivity_days=10
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
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

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
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

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

  it('should fall back to file+defaults when MongoDB read fails', async () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ inactivity_days: 5 }));

    const mockDb = {
      collection: jest.fn().mockReturnValue({
        find: jest.fn().mockReturnValue({
          toArray: jest.fn().mockRejectedValue(new Error('connection failed')),
        }),
      }),
    };

    const result = await loadSlaConfig(mockDb as any);

    expect(result.inactivity_days).toBe(5); // file value preserved
    expect(result.open_task_days).toBe(SLA_DEFAULTS.open_task_days);
  });
});
