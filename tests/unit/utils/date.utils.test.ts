import {
  getDailyPeriod,
  getWeeklyPeriod,
  getMonthlyPeriod,
  getPriorPeriod,
  formatSheetName,
  enumeratePeriods,
} from '@src/utils/date.utils';
import { ReportPeriod } from '@src/types/report';

describe('Date Utilities', () => {
  describe('getDailyPeriod', () => {
    it('returns yesterday 00:00 to 23:59:59.999 UTC', () => {
      const date = new Date('2024-03-15T10:00:00.000Z');
      const period = getDailyPeriod(date);

      expect(period.type).toBe('daily');
      expect(period.start).toEqual(new Date('2024-03-14T00:00:00.000Z'));
      expect(period.end).toEqual(new Date('2024-03-14T23:59:59.999Z'));
      expect(period.label).toBe('Daily_2024-03-14');
    });

    it('handles first day of month (crosses month boundary)', () => {
      const date = new Date('2024-03-01T00:00:00.000Z');
      const period = getDailyPeriod(date);

      expect(period.start).toEqual(new Date('2024-02-29T00:00:00.000Z'));
      expect(period.end).toEqual(new Date('2024-02-29T23:59:59.999Z'));
      expect(period.label).toBe('Daily_2024-02-29');
    });

    it('handles first day of year', () => {
      const date = new Date('2024-01-01T12:00:00.000Z');
      const period = getDailyPeriod(date);

      expect(period.start).toEqual(new Date('2023-12-31T00:00:00.000Z'));
      expect(period.label).toBe('Daily_2023-12-31');
    });
  });

  describe('getWeeklyPeriod', () => {
    it('returns last Monday to last Sunday', () => {
      // 2024-03-15 is a Friday
      const date = new Date('2024-03-15T10:00:00.000Z');
      const period = getWeeklyPeriod(date);

      expect(period.type).toBe('weekly');
      // Last week: Mon Mar 4 to Sun Mar 10
      expect(period.start).toEqual(new Date('2024-03-04T00:00:00.000Z'));
      expect(period.end).toEqual(new Date('2024-03-10T23:59:59.999Z'));
      expect(period.label).toBe('Weekly_2024-W10');
    });

    it('handles week crossing year boundary', () => {
      // 2024-01-03 is a Wednesday; last week is Dec 25-31 2023
      const date = new Date('2024-01-03T10:00:00.000Z');
      const period = getWeeklyPeriod(date);

      expect(period.type).toBe('weekly');
      expect(period.start).toEqual(new Date('2023-12-25T00:00:00.000Z'));
      expect(period.end).toEqual(new Date('2023-12-31T23:59:59.999Z'));
      expect(period.label).toBe('Weekly_2023-W52');
    });
  });

  describe('getMonthlyPeriod', () => {
    it('returns 1st to last day of previous month', () => {
      const date = new Date('2024-03-15T10:00:00.000Z');
      const period = getMonthlyPeriod(date);

      expect(period.type).toBe('monthly');
      expect(period.start).toEqual(new Date('2024-02-01T00:00:00.000Z'));
      expect(period.end).toEqual(new Date('2024-02-29T23:59:59.999Z'));
      expect(period.label).toBe('Monthly_2024-02');
    });

    it('handles January (previous month is December of prior year)', () => {
      const date = new Date('2024-01-15T10:00:00.000Z');
      const period = getMonthlyPeriod(date);

      expect(period.start).toEqual(new Date('2023-12-01T00:00:00.000Z'));
      expect(period.end).toEqual(new Date('2023-12-31T23:59:59.999Z'));
      expect(period.label).toBe('Monthly_2023-12');
    });

    it('handles leap year February', () => {
      const date = new Date('2024-03-01T00:00:00.000Z');
      const period = getMonthlyPeriod(date);

      expect(period.end).toEqual(new Date('2024-02-29T23:59:59.999Z'));
    });
  });

  describe('getPriorPeriod', () => {
    it('returns the prior daily period', () => {
      const period: ReportPeriod = {
        start: new Date('2024-03-14T00:00:00.000Z'),
        end: new Date('2024-03-14T23:59:59.999Z'),
        type: 'daily',
        label: 'Daily_2024-03-14',
      };
      const prior = getPriorPeriod(period, 'daily');

      expect(prior.start).toEqual(new Date('2024-03-13T00:00:00.000Z'));
      expect(prior.end).toEqual(new Date('2024-03-13T23:59:59.999Z'));
      expect(prior.type).toBe('daily');
    });

    it('returns the prior weekly period', () => {
      const period: ReportPeriod = {
        start: new Date('2024-03-04T00:00:00.000Z'),
        end: new Date('2024-03-10T23:59:59.999Z'),
        type: 'weekly',
        label: 'Weekly_2024-W10',
      };
      const prior = getPriorPeriod(period, 'weekly');

      // getWeeklyPeriod(Mar 4) goes back 7 days to Feb 26, which is in W09
      expect(prior.start).toEqual(new Date('2024-02-26T00:00:00.000Z'));
      expect(prior.end).toEqual(new Date('2024-03-03T23:59:59.999Z'));
      expect(prior.type).toBe('weekly');
    });

    it('returns the prior monthly period', () => {
      const period: ReportPeriod = {
        start: new Date('2024-02-01T00:00:00.000Z'),
        end: new Date('2024-02-29T23:59:59.999Z'),
        type: 'monthly',
        label: 'Monthly_2024-02',
      };
      const prior = getPriorPeriod(period, 'monthly');

      expect(prior.start).toEqual(new Date('2024-01-01T00:00:00.000Z'));
      expect(prior.end).toEqual(new Date('2024-01-31T23:59:59.999Z'));
      expect(prior.type).toBe('monthly');
    });
  });

  describe('formatSheetName', () => {
    it('formats daily sheet name as Daily_YYYY-MM-DD', () => {
      const period: ReportPeriod = {
        start: new Date('2024-03-14T00:00:00.000Z'),
        end: new Date('2024-03-14T23:59:59.999Z'),
        type: 'daily',
        label: 'Daily_2024-03-14',
      };
      expect(formatSheetName(period, 'daily')).toBe('Daily_2024-03-14');
    });

    it('formats weekly sheet name as Weekly_YYYY-WXX with zero-padded week', () => {
      const period: ReportPeriod = {
        start: new Date('2024-01-01T00:00:00.000Z'),
        end: new Date('2024-01-07T23:59:59.999Z'),
        type: 'weekly',
        label: 'Weekly_2024-W01',
      };
      expect(formatSheetName(period, 'weekly')).toBe('Weekly_2024-W01');
    });

    it('formats monthly sheet name as Monthly_YYYY-MM', () => {
      const period: ReportPeriod = {
        start: new Date('2024-02-01T00:00:00.000Z'),
        end: new Date('2024-02-29T23:59:59.999Z'),
        type: 'monthly',
        label: 'Monthly_2024-02',
      };
      expect(formatSheetName(period, 'monthly')).toBe('Monthly_2024-02');
    });
  });

  describe('enumeratePeriods', () => {
    it('enumerates daily periods for a 3-day range', () => {
      const from = new Date('2024-03-01T00:00:00.000Z');
      const to = new Date('2024-03-03T23:59:59.999Z');
      const { daily } = enumeratePeriods(from, to);

      expect(daily).toHaveLength(3);
      expect(daily[0].label).toBe('Daily_2024-03-01');
      expect(daily[1].label).toBe('Daily_2024-03-02');
      expect(daily[2].label).toBe('Daily_2024-03-03');
    });

    it('enumerates weekly periods overlapping a range', () => {
      // Mar 1 (Fri) to Mar 20 (Wed) — covers weeks W09, W10, W11, W12
      const from = new Date('2024-03-01T00:00:00.000Z');
      const to = new Date('2024-03-20T23:59:59.999Z');
      const { weekly } = enumeratePeriods(from, to);

      expect(weekly.length).toBeGreaterThanOrEqual(3);
      weekly.forEach((w) => {
        expect(w.type).toBe('weekly');
        expect(w.label).toMatch(/^Weekly_\d{4}-W\d{2}$/);
      });
    });

    it('enumerates monthly periods overlapping a range', () => {
      const from = new Date('2024-01-15T00:00:00.000Z');
      const to = new Date('2024-03-15T23:59:59.999Z');
      const { monthly } = enumeratePeriods(from, to);

      expect(monthly).toHaveLength(3);
      expect(monthly[0].label).toBe('Monthly_2024-01');
      expect(monthly[1].label).toBe('Monthly_2024-02');
      expect(monthly[2].label).toBe('Monthly_2024-03');
    });

    it('returns single-day range correctly', () => {
      const date = new Date('2024-03-15T00:00:00.000Z');
      const { daily } = enumeratePeriods(date, date);

      expect(daily).toHaveLength(1);
      expect(daily[0].label).toBe('Daily_2024-03-15');
    });

    it('each daily period has correct start/end boundaries', () => {
      const from = new Date('2024-03-01T00:00:00.000Z');
      const to = new Date('2024-03-02T23:59:59.999Z');
      const { daily } = enumeratePeriods(from, to);

      daily.forEach((d) => {
        expect(d.start.getUTCHours()).toBe(0);
        expect(d.start.getUTCMinutes()).toBe(0);
        expect(d.end.getUTCHours()).toBe(23);
        expect(d.end.getUTCMinutes()).toBe(59);
        expect(d.end.getUTCSeconds()).toBe(59);
        expect(d.end.getUTCMilliseconds()).toBe(999);
      });
    });
  });
});
