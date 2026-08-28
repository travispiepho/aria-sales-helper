export const SCHEDULE_TIME_ZONE = 'America/Detroit';

function partsFor(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
}

function parseLocalDateTime(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(value || ''));
  if (!match) throw Object.assign(new Error('Choose a valid date and time.'), { statusCode: 400 });
  const [, year, month, day, hour, minute] = match.map(Number);
  const expected = { year, month, day, hour, minute, second: 0 };
  const normalized = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (
    normalized.getUTCFullYear() !== year || normalized.getUTCMonth() !== month - 1 ||
    normalized.getUTCDate() !== day || normalized.getUTCHours() !== hour ||
    normalized.getUTCMinutes() !== minute
  ) throw Object.assign(new Error('Choose a valid date and time.'), { statusCode: 400 });
  return expected;
}

function sameLocal(actual, expected) {
  return actual.year === expected.year && actual.month === expected.month &&
    actual.day === expected.day && actual.hour === expected.hour &&
    actual.minute === expected.minute;
}

/** Resolve a wall-clock time without trusting the browser's local timezone. */
export function resolveScheduledTime(localValue, timeZone, now = new Date()) {
  if (timeZone !== SCHEDULE_TIME_ZONE) {
    throw Object.assign(new Error(`Timezone must be ${SCHEDULE_TIME_ZONE}.`), { statusCode: 400 });
  }
  const expected = parseLocalDateTime(localValue);
  const center = Date.UTC(expected.year, expected.month - 1, expected.day, expected.hour, expected.minute);
  const matches = [];
  // America/Detroit is always within this window. Minute stepping makes DST
  // gaps and repeated fall-back wall times explicit instead of guessing.
  for (let deltaMinutes = -12 * 60; deltaMinutes <= 12 * 60; deltaMinutes += 1) {
    const candidate = new Date(center + deltaMinutes * 60_000);
    if (sameLocal(partsFor(candidate, timeZone), expected)) matches.push(candidate);
  }
  if (matches.length === 0) {
    throw Object.assign(new Error('That local time does not exist because of the daylight-saving change. Choose another time.'), { statusCode: 400 });
  }
  if (matches.length > 1) {
    throw Object.assign(new Error('That local time occurs twice because of the daylight-saving change. Choose another time.'), { statusCode: 400 });
  }
  if (matches[0].getTime() <= now.getTime()) {
    throw Object.assign(new Error('Scheduled meetings must be in the future.'), { statusCode: 400 });
  }
  return matches[0];
}
