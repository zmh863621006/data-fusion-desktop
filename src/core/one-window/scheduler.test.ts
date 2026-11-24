import { describe, expect, it } from 'vitest';
import { DEFAULT_ONE_WINDOW_SCHEDULE, nextScheduleTime, parseOneWindowSchedule } from './scheduler';

describe('one-window schedule in Asia/Shanghai', () => {
  const now = Date.parse('2026-11-24T01:00:00Z'); // Tuesday, 09:00 in Shenzhen.

  it('keeps collection disabled until explicitly enabled and validates renderer updates', () => {
    const defaults = parseOneWindowSchedule({});
    expect(defaults).toEqual(DEFAULT_ONE_WINDOW_SCHEDULE);
    expect(nextScheduleTime(defaults, now)).toBeNull();
    expect(parseOneWindowSchedule({ enabled: true, intervalMinutes: 30 }, defaults).enabled).toBe(true);
    for (const value of [null, [], { enabled: 'true' }, { intervalMinutes: 0 }, { intervalMinutes: 1.5 },
      { time: '24:00' }, { weekdays: [0] }, { mode: 'weekly', weekdays: [] }, { unrelated: true }]) {
      expect(() => parseOneWindowSchedule(value)).toThrow();
    }
    const normalized = parseOneWindowSchedule({ weekdays: [7, 1, 1, 3] });
    expect(normalized.weekdays).toEqual([1, 3, 7]);
    normalized.weekdays.push(5);
    expect(DEFAULT_ONE_WINDOW_SCHEDULE.weekdays).toEqual([1, 2, 3, 4, 5]);
  });

  it('calculates interval and daily occurrences strictly after the reference instant', () => {
    expect(nextScheduleTime(parseOneWindowSchedule({ enabled: true, intervalMinutes: 15 }), now)).toBe(now + 15 * 60_000);
    const daily = parseOneWindowSchedule({ enabled: true, mode: 'daily', time: '09:00' });
    expect(nextScheduleTime(daily, now - 1)).toBe(now);
    expect(nextScheduleTime(daily, now)).toBe(Date.parse('2026-11-25T01:00:00Z'));
    expect(nextScheduleTime(parseOneWindowSchedule({ enabled: true, mode: 'daily', time: '00:00' }),
      Date.parse('2026-11-24T15:59:59.999Z'))).toBe(Date.parse('2026-11-24T16:00:00Z'));
  });

  it('respects selected weekdays across week and year boundaries without using host timezone', () => {
    const weekly = parseOneWindowSchedule({ enabled: true, mode: 'weekly', time: '09:00', weekdays: [1, 3, 5] });
    expect(nextScheduleTime(weekly, now)).toBe(Date.parse('2026-11-25T01:00:00Z'));
    const sunday = parseOneWindowSchedule({ enabled: true, mode: 'weekly', time: '00:10', weekdays: [7] });
    expect(nextScheduleTime(sunday, Date.parse('2026-12-31T23:00:00Z'))).toBe(Date.parse('2027-01-02T16:10:00Z'));
    expect(nextScheduleTime(sunday, Date.parse('2027-01-02T16:10:00Z'))).toBe(Date.parse('2027-01-09T16:10:00Z'));
    expect(() => nextScheduleTime(weekly, NaN)).toThrow();
  });
});
