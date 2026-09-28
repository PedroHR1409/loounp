export const DISCOVERY_INTERVAL_OPTIONS = [0, 6, 12, 24] as const;
export type DiscoveryIntervalHours = (typeof DISCOVERY_INTERVAL_OPTIONS)[number];

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const DEFAULT_CHECK_FREQUENCY_MS = MINUTE_MS;
const GMT_MINUS_3_OFFSET_MS = -3 * HOUR_MS;

export const DEFAULT_DISCOVERY_TIME_GMT_MINUS_3 = "09:00";

export function isValidDiscoveryInterval(
  value: number,
): value is DiscoveryIntervalHours {
  return (DISCOVERY_INTERVAL_OPTIONS as readonly number[]).includes(value);
}

export function isValidDiscoveryTime(value: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function dailyScheduleSlotKey(now: Date, time: string): string | null {
  if (!isValidDiscoveryTime(time)) return null;
  const fixedOffsetDate = new Date(now.getTime() + GMT_MINUS_3_OFFSET_MS);
  return `${fixedOffsetDate.toISOString().slice(0, 10)} ${time}`;
}

export function isDueForDailySchedule(
  now: Date,
  time: string,
  lastSlot: string | null,
): boolean {
  const slot = dailyScheduleSlotKey(now, time);
  if (!slot) return false;
  const fixedOffsetDate = new Date(now.getTime() + GMT_MINUS_3_OFFSET_MS);
  const currentMinutes =
    fixedOffsetDate.getUTCHours() * 60 + fixedOffsetDate.getUTCMinutes();
  const [hours, minutes] = time.split(":").map(Number);
  return currentMinutes >= hours * 60 + minutes && lastSlot !== slot;
}

/** Pure: no I/O, no timers — decides only whether enough time has passed. */
export function isDueForAutoDiscovery(
  now: Date,
  lastRunAt: string | null,
  intervalHours: DiscoveryIntervalHours,
): boolean {
  if (intervalHours === 0) return false;
  if (!lastRunAt) return true;
  const last = Date.parse(lastRunAt);
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= intervalHours * HOUR_MS;
}

/** Checks immediately (catch-up) and polls while the app process stays running. */
export function startDiscoveryScheduler(options: {
  getIntervalHours: () => number;
  getLastRunAt: () => string | null;
  getDailyTime?: () => string;
  getLastDailySlot?: () => string | null;
  onDue: () => void;
  now?: () => Date;
  checkFrequencyMs?: number;
}): { stop: () => void } {
  const now = options.now ?? (() => new Date());
  const frequency = options.checkFrequencyMs ?? DEFAULT_CHECK_FREQUENCY_MS;
  const check = () => {
    const interval = options.getIntervalHours();
    if (!isValidDiscoveryInterval(interval)) return;
    if (interval === 24) {
      if (
        isDueForDailySchedule(
          now(),
          options.getDailyTime?.() ?? DEFAULT_DISCOVERY_TIME_GMT_MINUS_3,
          options.getLastDailySlot?.() ?? null,
        )
      )
        options.onDue();
      return;
    }
    if (isDueForAutoDiscovery(now(), options.getLastRunAt(), interval))
      options.onDue();
  };
  check();
  const timer = setInterval(check, frequency);
  return { stop: () => clearInterval(timer) };
}
