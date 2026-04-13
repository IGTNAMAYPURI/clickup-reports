/**
 * Sheet formatting logic — data preparation and format constants.
 *
 * Provides:
 * - DEFAULT_SHEET_FORMAT: standard formatting values for all report sheets
 * - buildHyperlinkFormula: creates =HYPERLINK() formulas for task IDs
 * - getAtRiskColor: maps AtRiskFlag to its hex color
 * - formatTaskBreakdownData: converts TaskBreakdownRow[] to values[][] with hyperlinks and color info
 *
 * Requirements: 10.3, 10.4, 10.5, 10.6, 10.7, 9.5
 */

import type { SheetFormat } from '@src/types/sheets';
import type { TaskBreakdownRow, AtRiskFlag, FlagSeverity } from '@src/types/report';

// ---------------------------------------------------------------------------
// Default format constant
// ---------------------------------------------------------------------------

export const DEFAULT_SHEET_FORMAT: SheetFormat = {
  headerStyle: {
    bold: true,
    frozen: true,
    backgroundColor: '#1A73E8',
    textColor: '#FFFFFF',
  },
  alternatingRowColors: {
    color1: '#FFFFFF',
    color2: '#F3F3F3',
  },
  numericAlignment: 'RIGHT',
  atRiskColors: {
    overdue: '#FF0000',
    inactive: '#FF9900',
    open_too_long: '#FFFF00',
    high_rework: '#FF9900',
  },
};

// ---------------------------------------------------------------------------
// Hyperlink formula builder
// ---------------------------------------------------------------------------

/**
 * Builds a Google Sheets =HYPERLINK() formula linking a task ID to its ClickUp URL.
 *
 * Requirement 10.6: Task ID values rendered as hyperlinks to ClickUp task URL.
 */
export function buildHyperlinkFormula(url: string, taskId: string): string {
  return `=HYPERLINK("${url}", "${taskId}")`;
}

// ---------------------------------------------------------------------------
// At-risk color mapping
// ---------------------------------------------------------------------------

const FLAG_COLOR_MAP: Record<AtRiskFlag, string> = {
  overdue: DEFAULT_SHEET_FORMAT.atRiskColors.overdue,
  inactive: DEFAULT_SHEET_FORMAT.atRiskColors.inactive,
  open_too_long: DEFAULT_SHEET_FORMAT.atRiskColors.open_too_long,
  high_rework: DEFAULT_SHEET_FORMAT.atRiskColors.high_rework,
};

/**
 * Returns the hex color string for a given at-risk flag type.
 * Returns null when the flag is null (task is not at risk).
 *
 * Requirement 10.7: Color-coded formatting for at-risk flag cells.
 */
export function getAtRiskColor(flag: AtRiskFlag | null): string | null {
  if (flag === null) return null;
  return FLAG_COLOR_MAP[flag] ?? null;
}

// ---------------------------------------------------------------------------
// Task breakdown data formatter
// ---------------------------------------------------------------------------

/** Header labels for the task breakdown table. */
export const TASK_BREAKDOWN_HEADERS: string[] = [
  'Task ID',
  'Task Name',
  'Parent Task',
  'Subtask',
  'List / Folder',
  'Status',
  'Priority',
  'Story Points',
  'Rework Count',
  'Time Estimated',
  'Time Logged',
  'Due Date',
  'Date Closed',
  'On Time',
  'Days Open',
  'Last Activity',
  'At-Risk Flag',
  'Tags',
];

export interface FormattedRow {
  values: (string | number | boolean | null)[];
  atRiskColor: string | null;
}

/**
 * Converts an array of TaskBreakdownRow into a 2-D values array ready for
 * `writeData`, plus per-row at-risk color info for conditional formatting.
 *
 * The first element is the header row. Task IDs are rendered as =HYPERLINK()
 * formulas pointing to the ClickUp URL.
 *
 * Requirements: 10.3, 10.4, 10.5, 10.6, 10.7
 */
export function formatTaskBreakdownData(rows: TaskBreakdownRow[]): {
  headers: string[];
  formattedRows: FormattedRow[];
} {
  const formattedRows: FormattedRow[] = rows.map((row) => ({
    values: [
      buildHyperlinkFormula(row.clickup_url, row.task_id),
      row.task_name,
      row.parent_task_id ?? '',
      row.is_subtask,
      row.list_folder,
      row.status,
      row.priority,
      row.story_points,
      row.rework_count,
      row.time_estimated_ms,
      row.time_logged_ms,
      row.due_date ? row.due_date.toISOString().split('T')[0] : '',
      row.date_closed ? row.date_closed.toISOString().split('T')[0] : '',
      row.on_time === null ? '' : row.on_time,
      row.days_open,
      row.last_activity.toISOString().split('T')[0],
      row.at_risk_flag ?? '',
      row.tags.join(', '),
    ],
    atRiskColor: getAtRiskColor(row.at_risk_flag),
  }));

  return { headers: TASK_BREAKDOWN_HEADERS, formattedRows };
}
