import { normalizeTask, normalizeTasks } from '@src/services/sync/task-normalizer';
import { ClickUpTask, TimeInStatusResponse } from '@src/types/clickup';

/**
 * Helper to build a minimal valid ClickUpTask for testing.
 * Override any field via the `overrides` parameter.
 */
function makeTask(overrides: Partial<ClickUpTask> = {}): ClickUpTask {
  return {
    id: 'task-1',
    name: 'Test Task',
    description: 'A test task',
    status: { status: 'IN PROGRESS', type: 'custom' },
    priority: { id: '2', priority: 'high' },
    assignees: [{ id: 100, username: 'dev1', email: 'dev1@test.com' }],
    tags: [{ name: 'frontend' }],
    due_date: '1700000000000',
    date_created: '1699000000000',
    date_closed: null,
    date_updated: '1700500000000',
    custom_fields: [],
    parent: null,
    url: 'https://app.clickup.com/t/task-1',
    list: { id: 'list-1', name: 'Sprint 1' },
    folder: { id: 'folder-1', name: 'Project A' },
    space: { id: 'space-1' },
    time_estimate: 3600000,
    points: 5,
    ...overrides,
  };
}

describe('normalizeTask', () => {
  it('should map basic ClickUpTask fields to TaskSnapshot', () => {
    const task = makeTask();
    const snapshot = normalizeTask(task);

    expect(snapshot.clickup_task_id).toBe('task-1');
    expect(snapshot.name).toBe('Test Task');
    expect(snapshot.status).toBe('IN PROGRESS');
    expect(snapshot.normalized_status).toBe('active');
    expect(snapshot.priority).toBe('high');
    expect(snapshot.assignee_id).toBe('100');
    expect(snapshot.assignee_name).toBe('dev1');
    expect(snapshot.list_id).toBe('list-1');
    expect(snapshot.list_name).toBe('Sprint 1');
    expect(snapshot.folder_name).toBe('Project A');
    expect(snapshot.space_name).toBe('space-1');
    expect(snapshot.tags).toEqual(['frontend']);
    expect(snapshot.clickup_url).toBe('https://app.clickup.com/t/task-1');
  });

  it('should set story_points from the points field', () => {
    const task = makeTask({ points: 8 });
    expect(normalizeTask(task).story_points).toBe(8);
  });

  it('should set story_points to null when points is null', () => {
    const task = makeTask({ points: null });
    expect(normalizeTask(task).story_points).toBeNull();
  });

  it('should extract Rework Count custom field value', () => {
    const task = makeTask({
      custom_fields: [
        { id: 'cf-1', name: 'Rework Count', type: 'number', value: 3 },
      ],
    });
    expect(normalizeTask(task).rework_count).toBe(3);
  });

  it('should default rework_count to 0 when custom field is absent', () => {
    const task = makeTask({ custom_fields: [] });
    expect(normalizeTask(task).rework_count).toBe(0);
  });

  it('should default rework_count to 0 when custom field value is null', () => {
    const task = makeTask({
      custom_fields: [
        { id: 'cf-1', name: 'Rework Count', type: 'number', value: null },
      ],
    });
    expect(normalizeTask(task).rework_count).toBe(0);
  });

  it('should handle case-insensitive Rework Count field name', () => {
    const task = makeTask({
      custom_fields: [
        { id: 'cf-1', name: 'rework count', type: 'number', value: 2 },
      ],
    });
    expect(normalizeTask(task).rework_count).toBe(2);
  });

  it('should set is_subtask = true when parent is non-null', () => {
    const task = makeTask({ parent: 'parent-1' });
    const snapshot = normalizeTask(task);
    expect(snapshot.is_subtask).toBe(true);
    expect(snapshot.parent_task_id).toBe('parent-1');
  });

  it('should set is_subtask = false when parent is null', () => {
    const task = makeTask({ parent: null });
    const snapshot = normalizeTask(task);
    expect(snapshot.is_subtask).toBe(false);
    expect(snapshot.parent_task_id).toBeNull();
  });

  it('should use the status classifier for normalized_status', () => {
    const cases: Array<{ status: string; expected: string }> = [
      { status: 'TO DO', expected: 'not_started' },
      { status: 'BUG FOUND', expected: 'not_started' },
      { status: 'IN PROGRESS', expected: 'active' },
      { status: 'PULL REQUEST', expected: 'active' },
      { status: 'COMPLETE', expected: 'done_in_qa' },
      { status: 'TESTING', expected: 'done_in_qa' },
      { status: 'DONE', expected: 'closed_completed' },
      { status: 'UNKNOWN STATUS', expected: 'not_started' },
    ];

    for (const { status, expected } of cases) {
      const task = makeTask({ status: { status, type: 'custom' } });
      expect(normalizeTask(task).normalized_status).toBe(expected);
    }
  });

  it('should build time_in_status from TimeInStatusResponse', () => {
    const task = makeTask();
    const tis: TimeInStatusResponse = {
      current_status: { status: 'in progress', total_time: { by_minute: 120 } },
      status_history: [
        { status: 'to do', total_time: { by_minute: 60 } },
      ],
    };

    const snapshot = normalizeTask(task, tis);
    expect(snapshot.time_in_status).toEqual({
      'in progress': 120 * 60_000,
      'to do': 60 * 60_000,
    });
  });

  it('should return empty time_in_status when no TimeInStatusResponse', () => {
    const task = makeTask();
    expect(normalizeTask(task).time_in_status).toEqual({});
  });

  it('should convert date strings to Date objects', () => {
    const task = makeTask({
      due_date: '1700000000000',
      date_created: '1699000000000',
      date_closed: '1701000000000',
      date_updated: '1700500000000',
    });
    const snapshot = normalizeTask(task);

    expect(snapshot.due_date).toEqual(new Date(1700000000000));
    expect(snapshot.date_created).toEqual(new Date(1699000000000));
    expect(snapshot.date_closed).toEqual(new Date(1701000000000));
    expect(snapshot.date_updated).toEqual(new Date(1700500000000));
  });

  it('should set due_date to null when absent', () => {
    const task = makeTask({ due_date: null });
    expect(normalizeTask(task).due_date).toBeNull();
  });

  it('should set date_closed to null when absent', () => {
    const task = makeTask({ date_closed: null });
    expect(normalizeTask(task).date_closed).toBeNull();
  });

  it('should set priority to "none" when priority is null', () => {
    const task = makeTask({ priority: null });
    expect(normalizeTask(task).priority).toBe('none');
  });

  it('should handle task with no assignees', () => {
    const task = makeTask({ assignees: [] });
    const snapshot = normalizeTask(task);
    expect(snapshot.assignee_id).toBe('');
    expect(snapshot.assignee_name).toBe('');
  });

  it('should set time_estimated from time_estimate', () => {
    const task = makeTask({ time_estimate: 7200000 });
    expect(normalizeTask(task).time_estimated).toBe(7200000);
  });

  it('should set time_estimated to null when time_estimate is null', () => {
    const task = makeTask({ time_estimate: null });
    expect(normalizeTask(task).time_estimated).toBeNull();
  });

  it('should set synced_at to a recent Date', () => {
    const before = Date.now();
    const snapshot = normalizeTask(makeTask());
    const after = Date.now();
    expect(snapshot.synced_at.getTime()).toBeGreaterThanOrEqual(before);
    expect(snapshot.synced_at.getTime()).toBeLessThanOrEqual(after);
  });

  it('should default rework_count to 0 for non-numeric custom field value', () => {
    const task = makeTask({
      custom_fields: [
        { id: 'cf-1', name: 'Rework Count', type: 'text', value: 'not-a-number' },
      ],
    });
    expect(normalizeTask(task).rework_count).toBe(0);
  });
});

describe('normalizeTasks', () => {
  it('should normalize an array of tasks', () => {
    const tasks = [makeTask({ id: 'a' }), makeTask({ id: 'b' })];
    const snapshots = normalizeTasks(tasks);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0].clickup_task_id).toBe('a');
    expect(snapshots[1].clickup_task_id).toBe('b');
  });

  it('should apply time-in-status data from the map', () => {
    const tasks = [makeTask({ id: 'a' }), makeTask({ id: 'b' })];
    const tisMap = new Map<string, TimeInStatusResponse>([
      [
        'a',
        {
          current_status: { status: 'open', total_time: { by_minute: 30 } },
          status_history: [],
        },
      ],
    ]);

    const snapshots = normalizeTasks(tasks, tisMap);
    expect(snapshots[0].time_in_status).toEqual({ open: 30 * 60_000 });
    expect(snapshots[1].time_in_status).toEqual({});
  });

  it('should return empty array for empty input', () => {
    expect(normalizeTasks([])).toEqual([]);
  });
});
