export const KYIV_TZ = 'Europe/Kyiv';

/** Current hour (0-23) in Kyiv. */
export function kyivHour(now: Date = new Date()): number {
  const h = new Intl.DateTimeFormat('en-GB', { timeZone: KYIV_TZ, hour: '2-digit', hourCycle: 'h23' }).format(now);
  return Number(h);
}

export function isWithinCallWindow(startHour: number, endHour: number, now: Date = new Date()): boolean {
  const h = kyivHour(now);
  return h >= startHour && h < endHour;
}
