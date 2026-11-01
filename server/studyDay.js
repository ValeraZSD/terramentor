// server/studyDay.js — what day it is for the learner.
//
// Two kinds of date live in this app, and they used to share one helper:
//
//   * A STORED date (`scheduled_start`, `deadline`, `study_time_since`, a study
//     clock hour key) is a calendar date or a UTC hour. It is parsed as UTC
//     midnight (`parseDate`) and all arithmetic on it stays UTC. Nothing here
//     changes that.
//   * The CURRENT day (which topics are due today, which are overdue, which
//     answers, reviews and minutes were today's) is the learner's own calendar
//     day, in the zone their device is in. Read as the UTC date, New York's
//     study day would turn over at 19:00, counting evening work against a day
//     that has not started, and Auckland's feed would say Tuesday until 13:00
//     on Wednesday.
//
// Where the zone comes from, first answer wins:
//
//   1. The request. Every call the page makes carries `X-Time-Zone`, the
//      browser's IANA name (src/api.ts), and `learnerClock` runs the request
//      inside it. A phone in another zone than the desktop reads its own day.
//   2. The last zone a page sent (the `time_zone` row), for work that has no
//      request (a background job, a script) and for a request without the
//      header (a page still on the build before this one).
//   3. UTC, before any page has spoken: a fresh library and every test that
//      sends no zone answer exactly as they did before.
//
// A zone NAME, never an offset: an offset is right for one instant, and the
// day it starts can be 23 or 25 hours long.
//
// A day is two INSTANTS: `start`, the first instant carrying the learner's
// date, and `end`, the first carrying the next one. So a day the clocks change
// on is exact, including in a zone whose clocks change AT midnight (that day
// has no 00:00 and begins at 01:00). A stored timestamp belongs to the day
// when it falls in [start, end); `IN_DAY` compares through julianday() because
// those columns hold two shapes, `…T…Z` from JS and `YYYY-MM-DD HH:MM:SS` from
// CURRENT_TIMESTAMP.

import { AsyncLocalStorage } from 'node:async_hooks';
import { knownTimeZone } from './chatContext.js';
import { getSetting, setSettingValue } from './settingsStore.js';

export const TIME_ZONE_HEADER = 'X-Time-Zone';
const TIME_ZONE_SETTING = 'time_zone';
const DAY_MS = 86_400_000;

const requestZone = new AsyncLocalStorage();

// One formatter per zone: building one costs far more than using it, and the
// zone database bounds how many there can be.
const formatters = new Map();
function wallFields(ms, timeZone) {
    let f = formatters.get(timeZone);
    if (!f) {
        f = new Intl.DateTimeFormat('en-US', {
            timeZone, hourCycle: 'h23',
            year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
        });
        formatters.set(timeZone, f);
    }
    const p = {};
    for (const part of f.formatToParts(ms)) p[part.type] = part.value;
    return p;
}

/** `YYYY-MM-DD` on a wall calendar in `timeZone` at the instant `ms`. */
export function localDate(ms, timeZone) {
    const p = wallFields(ms, timeZone);
    return `${p.year}-${p.month}-${p.day}`;
}

/** How far `timeZone`'s wall clock is ahead of UTC at the instant `ms`. */
function offsetAt(ms, timeZone) {
    const p = wallFields(ms, timeZone);
    const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
    return wall - Math.floor(ms / 1000) * 1000;
}

const utcDate = (ms) => new Date(ms).toISOString().slice(0, 10);

/** The first instant whose wall date in `timeZone` is `date`. */
function dayStartMs(date, timeZone) {
    const [y, m, d] = date.split('-').map(Number);
    const midnight = Date.UTC(y, m - 1, d);
    // The offset in force at the learner's midnight is one of the offsets a day
    // either side of it. Where the clocks change at midnight there are two, and
    // the day begins at the earlier instant that already carries its date.
    const candidates = [...new Set([-DAY_MS, 0, DAY_MS].map(k => offsetAt(midnight + k, timeZone)))]
        .map(offset => midnight - offset)
        .sort((a, b) => a - b);
    for (const t of candidates) {
        if (localDate(t, timeZone) === date && localDate(t - 1, timeZone) !== date) return t;
    }
    return midnight - offsetAt(midnight, timeZone);
}

/**
 * The zone "today" is read in: the request's, else the one the learner's page
 * last sent, else UTC.
 */
export function learnerTimeZone() {
    return requestZone.getStore()?.timeZone ?? knownTimeZone(getSetting(TIME_ZONE_SETTING, '')) ?? 'UTC';
}

/**
 * One calendar day as the instants it spans in `timeZone`: `start` inclusive,
 * `end` exclusive, as ISO strings (for SQL) and as milliseconds; `next` is the
 * date that begins at `end`.
 */
export function dayBounds(date, timeZone = learnerTimeZone()) {
    // `2026-02-31` is a shape a query string can carry; it is read as the day
    // Date.UTC rolls it to, never as a day that matches nothing.
    const [y, m, d] = String(date).split('-').map(Number);
    const day = utcDate(Date.UTC(y, m - 1, d));
    const next = utcDate(Date.UTC(y, m - 1, d + 1));
    const startMs = dayStartMs(day, timeZone);
    const endMs = dayStartMs(next, timeZone);
    return {
        date: day,
        next,
        start: new Date(startMs).toISOString(),
        end: new Date(endMs).toISOString(),
        startMs,
        endMs,
        timeZone,
    };
}

/** Today's date for the learner. */
export function studyToday({ now = Date.now(), timeZone = learnerTimeZone() } = {}) {
    return localDate(now, timeZone);
}

/** Today for the learner, with the instants it spans (see `dayBounds`). */
export function studyDay({ now = Date.now(), timeZone = learnerTimeZone() } = {}) {
    return dayBounds(localDate(now, timeZone), timeZone);
}

/**
 * `col` falls on the day: bind the day's `start, end` for the two `?`. Through
 * julianday() so both stored shapes compare (see the note at the top).
 */
export const IN_DAY = (col) => `julianday(${col}) >= julianday(?) AND julianday(${col}) < julianday(?)`;

/**
 * Keep the zone a page sent, for whatever asks with no request. Written only
 * when it changes: two devices in two zones each move it, nothing else does.
 */
function rememberTimeZone(zone) {
    if (getSetting(TIME_ZONE_SETTING, null) !== zone) setSettingValue(TIME_ZONE_SETTING, zone);
}

/**
 * Express middleware: run the rest of the request in the zone its page sent.
 * A missing or unknown name is not obeyed; the request falls back to the zone
 * last heard. Mounted after the password check, so only the learner's own
 * pages move the remembered zone.
 */
export function learnerClock(req, res, next) {
    const zone = knownTimeZone(req.get(TIME_ZONE_HEADER));
    if (!zone) return next();
    try { rememberTimeZone(zone); } catch { /* a busy database must not fail the request it is only noting */ }
    return requestZone.run({ timeZone: zone }, next);
}
