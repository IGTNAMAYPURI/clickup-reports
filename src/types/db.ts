import { ObjectId } from 'mongodb';

import { NormalizedStatus } from '@src/types/report';

export interface RawTask {
  _id: ObjectId;
  clickup_task_id: string;
  list_id: string;
  space_id: string;
  data: Record<string, unknown>; // full ClickUp API response body
  fetched_at: Date;
  updated_at: Date;
}

export interface TaskSnapshot {
  _id: ObjectId;
  clickup_task_id: string;
  name: string;
  description?: string;
  status: string; // raw ClickUp status
  normalized_status: NormalizedStatus;
  priority: string;
  assignee_id: string;
  assignee_name: string;
  list_id: string;
  list_name: string;
  folder_name: string;
  space_name: string;
  tags: string[];
  story_points: number | null;
  rework_count: number;
  time_estimated: number | null; // milliseconds
  time_logged: number | null; // milliseconds
  due_date: Date | null;
  date_created: Date;
  date_closed: Date | null;
  date_updated: Date;
  last_activity_date: Date;
  is_subtask: boolean;
  parent_task_id: string | null;
  time_in_status: Record<string, number>; // status → milliseconds
  clickup_url: string;
  synced_at: Date;
}

export interface Developer {
  _id: ObjectId;
  clickup_user_id: string;
  first_name: string;
  last_name: string;
  email: string;
  team_id: string;
  active: boolean;
}

export interface Team {
  _id: ObjectId;
  team_id: string;
  name: string;
  spreadsheet_id: string | null;
  members: string[]; // clickup_user_ids
}

export interface ReportSnapshot {
  _id: ObjectId;
  report_type: 'daily' | 'weekly' | 'monthly';
  period_start: Date;
  period_end: Date;
  team_id: string;
  status: 'success' | 'partial' | 'failed';
  failed_developers: string[]; // clickup_user_ids that failed
  metrics_summary: {
    total_tasks: number;
    tasks_closed: number;
    tasks_opened: number;
    story_points_completed: number;
  };
  spreadsheet_url: string | null;
  error_message?: string;
  error_stack?: string;
  correlation_id: string;
  generated_at: Date;
  duration_ms: number;
}

export interface SyncCursor {
  _id: ObjectId;
  list_id: string;
  last_synced_at: Date;
  last_cursor_value: number; // epoch ms for date_updated_gt
  tasks_fetched: number;
  status: 'success' | 'failed';
  error_message?: string;
}

export interface SlaConfig {
  _id: ObjectId;
  key: string;
  value: number;
  description: string;
  updated_at: Date;
}
