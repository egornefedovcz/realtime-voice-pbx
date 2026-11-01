// Business-hours check in a given IANA time zone. Use it in your instructions,
// e.g. "outside business hours, do not promise a call back today".
//
//   isWithinHours({ timeZone: 'Europe/Prague', days: [1,2,3,4,5], from: 9, to: 17 })
//   days: 0 = Sunday … 6 = Saturday; from/to: hours, `to` exclusive.
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function isWithinHours({ timeZone = 'UTC', days = [1, 2, 3, 4, 5], from = 9, to = 17 } = {}, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', hour: '2-digit', hour12: false }).formatToParts(now);
  const weekday = WEEKDAYS[parts.find((p) => p.type === 'weekday').value];
  const hour = parseInt(parts.find((p) => p.type === 'hour').value, 10) % 24;
  return days.includes(weekday) && hour >= from && hour < to;
}

module.exports = { isWithinHours };
