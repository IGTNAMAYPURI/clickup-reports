import { getISOWeek, getISOWeekYear } from 'date-fns';
import { ReportPeriod } from '@src/types/report';

export type ReportType = 'daily' | 'weekly' | 'monthly';

/** Returns a new Date set to 00:00:00.000 UTC for the given date. */
function startOfDayUTC(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** Returns a new Date set to 23:59:59.999 UTC for the given date. */
function endOfDayUTC(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(23, 59, 59, 999);
  return d;
}

/** Returns the Monday (start of ISO week) for the given date in UTC. */
function startOfISOWeekUTC(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  const day = d.getUTCDay(); // 0=Sun, 1=Mon, ...
  const diff = day === 0 ? 6 : day - 1; // days since Monday
  d.setUTCDate(d.getUTCDate() - diff);
  return d;
}

/** Returns the Sunday (end of ISO week) for the given date in UTC. */
function endOfISOWeekUTC(date: Date): Date {
  const start = startOfISOWeekUTC(date);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  end.setUTCHours(23, 59, 59, 999);
  return end;
}

/** Returns the 1st of the month at 00:00:00.000 UTC. */
function startOfMonthUTC(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

/** Returns the last day of the month at 23:59:59.999 UTC. */
function endOfMonthUTC(date: Date): Date {
  // Day 0 of next month = last day of current month
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
  lastDay.setUTCHours(23, 59, 59, 999);
  return lastDay;
}

/**
 * Returns the daily period for the day before the given date.
 * Period: yesterday 00:00:00.000 UTC to yesterday 23:59:59.999 UTC.
 */
export function getDailyPeriod(date: Date): ReportPeriod {
  const yesterday = new Date(date);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const start = startOfDayUTC(yesterday);
  const end = endOfDayUTC(yesterday);
  const label = `Daily_${formatUTCDate(start)}`;
  return { start, end, type: 'daily', label };
}

/**
 * Returns the weekly period for the ISO week before the given date.
 * Period: last Monday 00:00:00.000 UTC to last Sunday 23:59:59.999 UTC.
 */
export function getWeeklyPeriod(date: Date): ReportPeriod {
  // Go back 7 days to land in the previous week
  const lastWeekDate = new Date(date);
  lastWeekDate.setUTCDate(lastWeekDate.getUTCDate() - 7);
  const start = startOfISOWeekUTC(lastWeekDate);
  const end = endOfISOWeekUTC(lastWeekDate);
  const isoWeek = getISOWeek(start);
  const isoYear = getISOWeekYear(start);
  const label = `Weekly_${isoYear}-W${String(isoWeek).padStart(2, '0')}`;
  return { start, end, type: 'weekly', label };
}

/**
 * Returns the monthly period for the month before the given date.
 * Period: 1st of previous month 00:00:00.000 UTC to last day 23:59:59.999 UTC.
 */
export function getMonthlyPeriod(date: Date): ReportPeriod {
  const prevMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1));
  const start = startOfMonthUTC(prevMonth);
  const end = endOfMonthUTC(prevMonth);
  const label = `Monthly_${formatUTCYearMonth(start)}`;
  return { start, end, type: 'monthly', label };
}

/**
 * Returns the equivalent prior period for trend comparison.
 * - daily: the day before the given period's start
 * - weekly: the week before the given period's start
 * - monthly: the month before the given period's start
 */
export function getPriorPeriod(period: ReportPeriod, type: ReportType): ReportPeriod {
  switch (type) {
    case 'daily':
      return getDailyPeriod(period.start);
    case 'weekly':
      return getWeeklyPeriod(period.start);
    case 'monthly':
      return getMonthlyPeriod(period.start);
  }
}

/**
 * Formats a sheet name based on the period and report type.
 * - Daily: Daily_YYYY-MM-DD
 * - Weekly: Weekly_YYYY-WXX (ISO week, zero-padded)
 * - Monthly: Monthly_YYYY-MM
 */
export function formatSheetName(period: ReportPeriod, type: ReportType): string {
  switch (type) {
    case 'daily':
      return `Daily_${formatUTCDate(period.start)}`;
    case 'weekly': {
      const isoWeek = getISOWeek(period.start);
      const isoYear = getISOWeekYear(period.start);
      return `Weekly_${isoYear}-W${String(isoWeek).padStart(2, '0')}`;
    }
    case 'monthly':
      return `Monthly_${formatUTCYearMonth(period.start)}`;
  }
}

/**
 * Enumerates all daily, weekly, and monthly periods within a date range [from, to].
 * - Daily: every calendar day in the range
 * - Weekly: every ISO week that overlaps the range (weeks start on Monday)
 * - Monthly: every calendar month that overlaps the range
 */
export function enumeratePeriods(
  from: Date,
  to: Date,
): { daily: ReportPeriod[]; weekly: ReportPeriod[]; monthly: ReportPeriod[] } {
  const daily = enumerateDailyPeriods(from, to);
  const weekly = enumerateWeeklyPeriods(from, to);
  const monthly = enumerateMonthlyPeriods(from, to);
  return { daily, weekly, monthly };
}

/** Format as YYYY-MM-DD using UTC components. */
function formatUTCDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Format as YYYY-MM using UTC components. */
function formatUTCYearMonth(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function enumerateDailyPeriods(from: Date, to: Date): ReportPeriod[] {
  const periods: ReportPeriod[] = [];
  const startDate = startOfDayUTC(from);
  const endDate = startOfDayUTC(to);

  let current = new Date(startDate);
  while (current <= endDate) {
    const start = startOfDayUTC(current);
    const end = endOfDayUTC(current);
    const label = `Daily_${formatUTCDate(start)}`;
    periods.push({ start, end, type: 'daily', label });
    current = new Date(current);
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return periods;
}

function enumerateWeeklyPeriods(from: Date, to: Date): ReportPeriod[] {
  const periods: ReportPeriod[] = [];
  // Start from the Monday of the week containing `from`
  let current = startOfISOWeekUTC(from);
  const endBound = startOfDayUTC(to);

  while (current <= endBound) {
    const start = startOfISOWeekUTC(current);
    const end = endOfISOWeekUTC(current);
    const isoWeek = getISOWeek(start);
    const isoYear = getISOWeekYear(start);
    const label = `Weekly_${isoYear}-W${String(isoWeek).padStart(2, '0')}`;
    periods.push({ start, end, type: 'weekly', label });
    // Advance by 7 days
    current = new Date(start);
    current.setUTCDate(current.getUTCDate() + 7);
  }
  return periods;
}

function enumerateMonthlyPeriods(from: Date, to: Date): ReportPeriod[] {
  const periods: ReportPeriod[] = [];
  let current = startOfMonthUTC(from);
  const endBound = startOfMonthUTC(to);

  while (current <= endBound) {
    const start = startOfMonthUTC(current);
    const end = endOfMonthUTC(current);
    const label = `Monthly_${formatUTCYearMonth(start)}`;
    periods.push({ start, end, type: 'monthly', label });
    // Advance to next month
    current = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 1));
  }
  return periods;
}
