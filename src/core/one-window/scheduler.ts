export type OneWindowScheduleMode = 'interval' | 'daily' | 'weekly';

export interface OneWindowSchedule {
  enabled: boolean;
  loginAutoRun: boolean;
  mode: OneWindowScheduleMode;
  intervalMinutes: number;
  time: string;
  /** ISO weekdays, Monday = 1 and Sunday = 7. */
  weekdays: number[];
}

export const DEFAULT_ONE_WINDOW_SCHEDULE: Readonly<OneWindowSchedule> = {
  enabled: false,
  loginAutoRun: false,
  mode: 'interval',
  intervalMinutes: 60,
  time: '09:00',
  weekdays: [1, 2, 3, 4, 5],
};

const DAY = 86_400_000;
const SHANGHAI_OFFSET = 8 * 60 * 60_000;
const SETTING_KEYS = new Set(Object.keys(DEFAULT_ONE_WINDOW_SCHEDULE));

/** Validates persisted settings and renderer updates at the main-process boundary. */
export function parseOneWindowSchedule(value: unknown, previous: Readonly<OneWindowSchedule> = DEFAULT_ONE_WINDOW_SCHEDULE): OneWindowSchedule {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !SETTING_KEYS.has(key))) throw new Error('定时回流设置格式无效');
  const settings = { ...previous, ...value };
  if (typeof settings.enabled !== 'boolean' || typeof settings.loginAutoRun !== 'boolean') throw new Error('定时回流开关无效');
  if (!['interval', 'daily', 'weekly'].includes(settings.mode)) throw new Error('请选择有效的定时回流方式');
  if (!Number.isInteger(settings.intervalMinutes) || settings.intervalMinutes < 1 || settings.intervalMinutes > 10_080) {
    throw new Error('回流间隔应为 1 至 10080 分钟');
  }
  if (typeof settings.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(settings.time)) throw new Error('定时回流时间应为有效的时分');
  if (!Array.isArray(settings.weekdays) || settings.weekdays.length > 7
    || settings.weekdays.some(day => !Number.isInteger(day) || day < 1 || day > 7)) throw new Error('定时回流星期无效');
  const weekdays = [...new Set(settings.weekdays)].sort((a, b) => a - b);
  if (settings.mode === 'weekly' && !weekdays.length) throw new Error('请至少选择一个回流星期');
  return { ...settings, weekdays };
}

/** Returns the next occurrence strictly after the supplied instant in Asia/Shanghai. */
export function nextScheduleTime(settings: OneWindowSchedule, after: number): number | null {
  const schedule = parseOneWindowSchedule(settings);
  if (!Number.isSafeInteger(after) || after < 0 || after > 8.64e15 - 8 * DAY) throw new Error('定时回流时间无效');
  if (!schedule.enabled) return null;
  if (schedule.mode === 'interval') return after + schedule.intervalMinutes * 60_000;
  const [hour, minute] = schedule.time.split(':').map(Number);
  const midnight = Math.floor((after + SHANGHAI_OFFSET) / DAY) * DAY - SHANGHAI_OFFSET;
  const candidate = midnight + hour * 3_600_000 + minute * 60_000;
  for (let day = 0; day <= 7; day++) {
    const time = candidate + day * DAY;
    const weekday = new Date(time + SHANGHAI_OFFSET).getUTCDay() || 7;
    if (time > after && (schedule.mode === 'daily' || schedule.weekdays.includes(weekday))) return time;
  }
  throw new Error('无法计算下一次回流时间');
}
