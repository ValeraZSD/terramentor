// server/paceModel.js — will this date work, judged from the learner's own record.
//
// Pure arithmetic over dates. No database, no clock, no randomness, no imports:
// "today" and every completion arrive as `YYYY-MM-DD` strings on the learner's
// own calendar, so the same facts give the same verdict wherever they are read
// (a library reading its own record, or a school recomputing it from the topic
// status and completion times a library sends it). The readers live in
// server/pace.js.
//
// The unit is work closed per WEEK: topics closed, or for a course measured in
// cards, new cards met. Never a per-day rate: real records hold bulk days (16
// topics in one sitting) and long empty stretches, and a day rate turns both
// into nonsense.
//
// Three numbers, each from the learner's own weeks:
//   recent  — the last 12 weeks, a week counting half as much every 4 weeks back
//   best    — the best 4 weeks in a row, ever: a pace the learner has shown
//   needed  — open work divided by the weeks left to the date
//
// The verdict compares them (bands below). It never prints one finish date: on a
// record that is a crunch and then nothing, a single predicted date missed the
// next four weeks by a median 61%. From four weeks of data it gives a RANGE
// (20th to 80th percentile of a seeded replay of the learner's own weeks) and
// names the stretch of weeks it replayed.

const DAY_MS = 86_400_000;

/** How many of the newest weeks the recent pace reads. */
export const RECENT_WEEKS = 12;
/** A week counts half as much every this many weeks back. */
export const HALF_LIFE_WEEKS = 4;
/** The best pace is the best run of this many weeks in a row. */
export const BEST_RUN_WEEKS = 4;
/** Needed at or below this share of the best pace is "under pace", above it "tight". */
export const UNDER_PACE_SHARE = 0.6;
/** Weeks of data before the app gives a verdict. */
export const VERDICT_FROM_WEEKS = 2;
/** Weeks of data before it gives a finish range. */
export const RANGE_FROM_WEEKS = 4;
/** With one week of data it speaks only when the date needs this many times the pace so far. */
export const EARLY_FACTOR = 2;
/** The record reaches back at most this many weeks (three years). */
export const MAX_HISTORY_WEEKS = 156;
/**
 * A date closer than this is judged as this many weeks of work: the weekly rate
 * divided by "one day left" would call the last topic of any course out of reach.
 */
export const MIN_HORIZON_WEEKS = 1;
export const RANGE_LOW = 0.2;
export const RANGE_HIGH = 0.8;
const REPLAYS = 2000;
const REPLAY_HORIZON_WEEKS = 520;
const REPLAY_SEED = 0x5eed;
// Comparisons of two paces tolerate float noise: 0.6 x 6 is 3.5999999999999996.
const EPS = 1e-9;

/**
 * learning     — under two weeks of data; `early` says whether the date already
 *                needs at least twice the pace so far
 * on_pace      — the recent pace is at least the pace needed
 * under_pace   — below it, but the date needs at most 60% of the best pace
 * tight        — the date needs more than 60% of the best pace, up to all of it
 * out_of_reach — the date needs more than the best pace ever held
 * done         — nothing open
 * passed       — the date has gone by, with work open (the deadline day itself
 *                still counts, as one week's work at least)
 * no_date      — the course has no date
 */
export const BANDS = ['learning', 'on_pace', 'under_pace', 'tight', 'out_of_reach', 'done', 'passed', 'no_date'];

/**
 * In the order they are offered, the ones that keep the date first:
 * fit_subset   — study the N that fit (out of reach)
 * plan_weekly  — plan N a week (tight or under pace)
 * check_known  — check what you already know (the placement check; topics only)
 * pause_others — pause the other courses (never for a date a teacher set)
 * move_date    — move the date (only a date the learner set and did not lock)
 */
export const OFFERS = ['fit_subset', 'plan_weekly', 'check_known', 'pause_others', 'move_date'];

const dayNum = (date) => Math.round(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
/** dayNum of a `YYYY-MM-DD` string, or null for anything else. */
function dayNumOf(date) {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const n = dayNum(date);
    // Date.parse rolls 2026-02-30 over to 2 March: a day that reads back
    // differently does not exist.
    return Number.isFinite(n) && dayStr(n) === date ? n : null;
}
const dayStr = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);
const weightOf = (weeksAgo) => Math.pow(0.5, weeksAgo / HALF_LIFE_WEEKS);
const round2 = (x) => (x == null ? null : Math.round(x * 100) / 100);

/**
 * The learner's weeks, from the days work was closed.
 *
 * Weeks are 7-day blocks ending YESTERDAY: today is not over, and a block that
 * held half of today would read every morning as a slow week. Only blocks that
 * start on or after `since` (the day the record begins) are weeks of data.
 *
 * @param {string[]} days   one `YYYY-MM-DD` per unit of work closed (repeats allowed)
 * @param {{ since: string|null, today: string }} at
 * @returns {{ weeks: Array<{ start: string, end: string, count: number }>, weeksOfData: number,
 *   recent: number|null, best: number|null, bestStretch: { start: string, end: string }|null,
 *   quietWeeks: number }}  weeks newest first
 */
export function learnerPace(days, { since, today }) {
    const t = dayNumOf(today);
    if (t == null) throw new TypeError(`learnerPace: today must be YYYY-MM-DD, got ${String(today).slice(0, 20)}`);
    // The facts may come from another party: a date that is not one is left
    // out, and the record reaches back at most MAX_HISTORY_WEEKS, so one
    // completion imported with a 1970 date cannot add fifty years of empty weeks.
    const sinceNum = dayNumOf(since);
    const first = sinceNum == null ? null : Math.max(sinceNum, t - MAX_HISTORY_WEEKS * 7);
    const perDay = new Map();
    for (const d of days || []) {
        const n = dayNumOf(d);
        if (n != null) perDay.set(n, (perDay.get(n) || 0) + 1);
    }
    const weeks = [];
    if (first != null) {
        for (let i = 0; ; i++) {
            const end = t - 1 - i * 7;
            const start = end - 6;
            if (start < first) break;
            let count = 0;
            for (let d = start; d <= end; d++) count += perDay.get(d) || 0;
            weeks.push({ start: dayStr(start), end: dayStr(end), count });
        }
    }

    const n = weeks.length;
    let recent = null;
    if (n > 0) {
        let sum = 0, wsum = 0;
        for (let i = 0; i < Math.min(n, RECENT_WEEKS); i++) {
            sum += weeks[i].count * weightOf(i);
            wsum += weightOf(i);
        }
        recent = sum / wsum;
    }

    // Best run of four (or of every week there is, while there are fewer). Newest
    // first, so of two equal runs the more recent one is named.
    let best = null, bestStretch = null;
    const run = Math.min(n, BEST_RUN_WEEKS);
    for (let i = 0; run > 0 && i + run <= n; i++) {
        let s = 0;
        for (let k = i; k < i + run; k++) s += weeks[k].count;
        const mean = s / run;
        if (best == null || mean > best + EPS) {
            best = mean;
            bestStretch = { start: weeks[i + run - 1].start, end: weeks[i].end };
        }
    }

    let quietWeeks = 0;
    while (quietWeeks < n && weeks[quietWeeks].count === 0) quietWeeks++;

    return { weeks, weeksOfData: n, recent, best, bestStretch, quietWeeks };
}

// mulberry32: a small seeded generator, so the same record gives the same range.
function seeded(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6D2B79F5) >>> 0;
        let x = s;
        x = Math.imul(x ^ (x >>> 15), x | 1);
        x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
        return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Replay `blocks` (weekly counts, drawn with `weights`) until `remaining` is
 * done, many times; the 20th and 80th percentile finish, in days from today.
 * Null when the weeks replayed cannot finish it within ten years.
 */
function replayRange(blocks, weights, remaining) {
    const total = weights.reduce((a, b) => a + b, 0);
    const mean = blocks.reduce((s, x, i) => s + x * weights[i], 0) / total;
    if (!(mean > 0) || mean * REPLAY_HORIZON_WEEKS < remaining) return null;
    const rand = seeded(REPLAY_SEED);
    const draw = () => {
        let r = rand() * total;
        for (let i = 0; i < blocks.length; i++) {
            r -= weights[i];
            if (r <= 0) return blocks[i];
        }
        return blocks[blocks.length - 1];
    };
    const finishes = [];
    for (let s = 0; s < REPLAYS; s++) {
        let left = remaining, wk = 0, at = Infinity;
        while (wk < REPLAY_HORIZON_WEEKS) {
            const x = draw();
            if (x >= left) { at = wk * 7 + Math.max(1, Math.ceil((left / x) * 7)); break; }
            left -= x;
            wk++;
        }
        finishes.push(at);
    }
    finishes.sort((a, b) => a - b);
    const q = (p) => finishes[Math.min(finishes.length - 1, Math.floor(p * finishes.length))];
    const low = q(RANGE_LOW), high = q(RANGE_HIGH);
    if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
    return { low, high };
}

function finishRanges(pace, open, t) {
    const none = { recent: null, best: null };
    if (pace.weeksOfData < RANGE_FROM_WEEKS || !(open > 0)) return none;
    const asRange = (r, stretch) => (r ? { from: dayStr(t + r.low - 1), to: dayStr(t + Math.max(r.high, r.low + 1) - 1), stretch } : null);

    const k = Math.min(pace.weeksOfData, RECENT_WEEKS);
    const recentBlocks = pace.weeks.slice(0, k);
    const recent = asRange(
        replayRange(recentBlocks.map(w => w.count), recentBlocks.map((_, i) => weightOf(i)), open),
        { start: recentBlocks[k - 1].start, end: recentBlocks[0].end },
    );

    let best = null;
    if (pace.bestStretch) {
        const bestBlocks = pace.weeks.filter(w => w.start >= pace.bestStretch.start && w.end <= pace.bestStretch.end);
        best = asRange(replayRange(bestBlocks.map(w => w.count), bestBlocks.map(() => 1), open), pace.bestStretch);
    }
    return { recent, best };
}

/**
 * The verdict on one date.
 *
 * @param {ReturnType<typeof learnerPace>} pace
 * @param {object} course
 * @param {number} course.open              work still open (topics, or cards not met yet)
 * @param {string|null} course.deadline     `YYYY-MM-DD`
 * @param {string} course.today             the learner's today, `YYYY-MM-DD`
 * @param {'topics'|'cards'} [course.unit]
 * @param {boolean} [course.fixed]          the learner ticked "cannot move"
 * @param {boolean} [course.assigned]       a teacher set the date (implies fixed)
 * @param {boolean} [course.canCheckKnown]  the placement check can run on this course
 * @param {number} [course.otherCourses]    other active courses with a date and open work
 */
export function judgeDate(pace, {
    open, deadline, today, unit = 'topics', fixed = false, assigned = false, canCheckKnown = false, otherCourses = 0,
}) {
    const t = dayNumOf(today);
    if (t == null) throw new TypeError(`judgeDate: today must be YYYY-MM-DD, got ${String(today).slice(0, 20)}`);
    const locked = Boolean(fixed || assigned);
    const due = dayNumOf(deadline);
    const daysLeft = due == null ? null : due - t;
    // The deadline day is still a day to study on (as `deadlineInfo` in
    // server/today.js counts it): a date is passed only once it has gone by.
    const weeksLeft = daysLeft != null && daysLeft >= 0 ? Math.max(daysLeft / 7, MIN_HORIZON_WEEKS) : null;
    const needed = weeksLeft ? open / weeksLeft : null;
    const recent = pace.recent;
    const best = pace.best;
    const fits = weeksLeft && best != null ? Math.min(open, Math.floor(best * weeksLeft + EPS)) : null;

    let band;
    let early = false;
    if (due == null) band = 'no_date';
    else if (!(open > 0)) band = 'done';
    else if (daysLeft < 0) band = 'passed';
    else if (pace.weeksOfData < VERDICT_FROM_WEEKS) {
        band = 'learning';
        // One week of data is enough to say "this needs twice what you are
        // doing", about 9 times in 10; it is not enough for anything finer.
        early = pace.weeksOfData >= 1 && needed >= EARLY_FACTOR * recent - EPS;
    } else if (recent >= needed - EPS) band = 'on_pace';
    else if (needed > best + EPS) band = 'out_of_reach';
    else if (needed > best * UNDER_PACE_SHARE + EPS) band = 'tight';
    else band = 'under_pace';

    const offers = [];
    const misses = band === 'under_pace' || band === 'tight' || band === 'out_of_reach';
    if (misses) {
        if (band === 'out_of_reach' && fits > 0) offers.push({ kind: 'fit_subset', count: fits });
        if (band !== 'out_of_reach') offers.push({ kind: 'plan_weekly', perWeek: Math.ceil(needed - EPS) });
        if (canCheckKnown && unit === 'topics') offers.push({ kind: 'check_known' });
        if (!assigned && otherCourses > 0) offers.push({ kind: 'pause_others' });
    }
    if ((misses || band === 'passed') && !locked) offers.push({ kind: 'move_date' });

    const showsRange = band !== 'no_date' && band !== 'done' && band !== 'passed';
    return {
        unit,
        band,
        early,
        open,
        deadline: due == null ? null : deadline,
        daysLeft,
        needed: round2(needed),
        recent: round2(recent),
        best: round2(best),
        bestStretch: pace.bestStretch,
        fits,
        weeksOfData: pace.weeksOfData,
        quietWeeks: pace.quietWeeks,
        ranges: showsRange ? finishRanges(pace, open, t) : { recent: null, best: null },
        owner: assigned ? 'teacher' : 'learner',
        fixed: locked,
        offers,
    };
}
