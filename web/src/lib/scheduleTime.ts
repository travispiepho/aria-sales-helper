export const SCHEDULE_TIME_ZONE = 'America/Detroit' as const;

export function defaultScheduledLocal(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SCHEDULE_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(now.getTime() + 60 * 60_000));
  const value = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}T${value.hour}:${value.minute}`;
}

export function scheduledLocalFromIso(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SCHEDULE_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const value = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}T${value.hour}:${value.minute}`;
}

export function formatScheduledTime(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: SCHEDULE_TIME_ZONE,
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(new Date(iso));
}
