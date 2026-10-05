// server/studyTime.js — the record of time actually spent studying.
//
// The page counts it (src/utils/studyTime.ts, the rule is there) and sends it
// here every half minute and when the learner leaves, as entries of
// "this topic, this activity, this UTC hour, this many milliseconds". This
// module keeps them in `study_time`, one row per (topic, hour, activity), and
// answers the questions the screens ask: how long on this topic, on this
// project, on this day.
//
// **By the hour, not the day.** A day is a time-zone question the rest of the
// app still answers in UTC (`todayStr`); an hour can be put into whichever
// local day a reader is in, a day cannot be split again. Readings here bucket
// by UTC day, like every other day in the app, so a day's minutes and the
// same day's ledger agree.
//
// **A flush is written once.** The page names each flush and resends a failed
// one under the same name; the name is remembered for a few days
// (`study_time_flushes`) and a replay writes nothing — a lost response must not
// count the same half hour twice.
//
// **Bounded, never trusted.** An entry is refused (and counted) unless its
// topic exists, its activity is one of five, its hour is a real hour no later
// than the next one and no older than a week, and its milliseconds are whole
// and fit in an hour. A row is capped at the hour it is in.

import db from './database.js';

export const STUDY_ACTIVITIES = ['reading', 'questions', 'cards', 'checks', 'paper'];

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** At most this much time fits in one row: the hour it is in. */
export const MAX_ROW_MS = HOUR_MS;
/** An entry older than this is refused: a page left open offline that long has nothing reliable to say. */
export const OLDEST_MS = 7 * DAY_MS;
/** How long a flush id is remembered, so a late retry is still recognised. */
const FLUSH_MEMORY_MS = 3 * DAY_MS;
export const MAX_ENTRIES = 500;
/** How many days of one topic's history a topic panel is sent. */
const TOPIC_DAYS_SHOWN = 60;
/** How many topics a project panel ranks. */
const PROJECT_TOPICS_SHOWN = 6;

const FLUSH_ID = /^[A-Za-z0-9_-]{8,64}$/;
const HOUR_KEY = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/;

/** A body the route must refuse with a 400 rather than write anything from. */
export class StudyTimeError extends Error {
    constructor(message) {
        super(message);
        this.status = 400;
    }
}

/** `2026-10-04T09` → its first millisecond, or null for anything that is not a real UTC hour. */
export function hourStart(key) {
    if (typeof key !== 'string') return null;
    const m = HOUR_KEY.exec(key);
    if (!m) return null;
    const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4]);
    // Round-trip, so month 13 and hour 24 (which Date.UTC rolls over) are refused.
    return new Date(ms).toISOString().slice(0, 13) === key ? ms : null;
}

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayRange = (day) => [`${day}T00`, `${day}T23`];

let stmts = null;
function statements() {
    if (stmts) return stmts;
    stmts = {
        rememberFlush: db.prepare('INSERT OR IGNORE INTO study_time_flushes (id, at) VALUES (?, ?)'),
        forgetFlushes: db.prepare('DELETE FROM study_time_flushes WHERE at < ?'),
        nodeExists: db.prepare('SELECT 1 FROM nodes WHERE id = ?'),
        add: db.prepare(`
            INSERT INTO study_time (node_id, hour, activity, active_ms) VALUES (?, ?, ?, ?)
            ON CONFLICT (node_id, hour, activity)
            DO UPDATE SET active_ms = MIN(active_ms + excluded.active_ms, ${MAX_ROW_MS})
        `),
        dayTotal: db.prepare('SELECT COALESCE(SUM(active_ms), 0) AS ms FROM study_time WHERE hour BETWEEN ? AND ?'),
        dayActivities: db.prepare('SELECT activity, SUM(active_ms) AS ms FROM study_time WHERE hour BETWEEN ? AND ? GROUP BY activity'),
        dayTopics: db.prepare(`
            SELECT st.node_id AS nodeId, SUM(st.active_ms) AS ms, n.title AS nodeTitle,
                   p.id AS projectId, p.name AS projectName, p.color AS projectColor
            FROM study_time st
            JOIN nodes n ON n.id = st.node_id
            JOIN projects p ON p.id = n.project_id
            WHERE st.hour BETWEEN ? AND ?
            GROUP BY st.node_id
            ORDER BY ms DESC, n.title
        `),
        daysBetween: db.prepare(`
            SELECT substr(hour, 1, 10) AS day, SUM(active_ms) AS ms
            FROM study_time WHERE hour BETWEEN ? AND ?
            GROUP BY day
        `),
        node: db.prepare(`
            SELECT n.id, p.created_at AS projectCreated
            FROM nodes n JOIN projects p ON p.id = n.project_id WHERE n.id = ?
        `),
        // A topic and everything filed under it: a section's time is its topics'.
        subtreeRows: db.prepare(`
            WITH RECURSIVE sub(id) AS (
                SELECT ? UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id
            )
            SELECT substr(st.hour, 1, 10) AS day, st.activity AS activity, SUM(st.active_ms) AS ms
            FROM study_time st WHERE st.node_id IN (SELECT id FROM sub)
            GROUP BY day, st.activity
        `),
        project: db.prepare('SELECT id, created_at FROM projects WHERE id = ?'),
        projectRows: db.prepare(`
            SELECT substr(st.hour, 1, 10) AS day, st.activity AS activity, SUM(st.active_ms) AS ms
            FROM study_time st JOIN nodes n ON n.id = st.node_id
            WHERE n.project_id = ?
            GROUP BY day, st.activity
        `),
        projectTopics: db.prepare(`
            SELECT st.node_id AS nodeId, n.title AS title, SUM(st.active_ms) AS ms
            FROM study_time st JOIN nodes n ON n.id = st.node_id
            WHERE n.project_id = ?
            GROUP BY st.node_id
            ORDER BY ms DESC, n.title
            LIMIT ${PROJECT_TOPICS_SHOWN}
        `),
        since: db.prepare("SELECT value FROM settings WHERE key = 'study_time_since'"),
    };
    return stmts;
}

/** The UTC day the clock started counting in this library, or null before its migration ran. */
export function studyTimeSince() {
    try { return statements().since.get()?.value || null; } catch { return null; }
}

/** Is `created` (a SQLite or ISO timestamp) on a day before the clock started? */
function predatesClock(created) {
    const since = studyTimeSince();
    const day = typeof created === 'string' ? created.slice(0, 10) : '';
    return !!since && !!day && day < since;
}

/** One entry as written, or null when it must be refused. */
function validEntry(e, now) {
    if (!e || typeof e !== 'object') return null;
    const { nodeId, activity, hour, ms } = e;
    if (!Number.isInteger(nodeId) || nodeId <= 0) return null;
    if (!STUDY_ACTIVITIES.includes(activity)) return null;
    const start = hourStart(hour);
    if (start == null || start > now + HOUR_MS || start < now - OLDEST_MS) return null;
    if (!Number.isInteger(ms) || ms <= 0 || ms > HOUR_MS) return null;
    return { nodeId, activity, hour, ms };
}

/**
 * Write one flush from the page.
 *
 * @param {{ flushId: string, entries: unknown[] }} body
 * @param {{ now?: number }} [opts]  `now` for the gate; the server's clock otherwise.
 * @returns {{ duplicate: boolean, written: number, dropped: number, date: string, todayMs: number }}
 *   `todayMs` is the whole library's time on today's UTC `date`, after this
 *   write — the number the page's live count starts from.
 */
export function recordStudyTime(body, { now = Date.now() } = {}) {
    if (!body || typeof body !== 'object') throw new StudyTimeError('Expected { flushId, entries }.');
    const { flushId, entries } = body;
    if (typeof flushId !== 'string' || !FLUSH_ID.test(flushId)) throw new StudyTimeError('flushId must be 8–64 letters, digits, "-" or "_".');
    if (!Array.isArray(entries)) throw new StudyTimeError('entries must be an array.');
    if (entries.length > MAX_ENTRIES) throw new StudyTimeError(`At most ${MAX_ENTRIES} entries per flush.`);

    const s = statements();
    const date = dayOf(now);
    const result = db.transaction(() => {
        s.forgetFlushes.run(new Date(now - FLUSH_MEMORY_MS).toISOString());
        if (s.rememberFlush.run(flushId, new Date(now).toISOString()).changes === 0) {
            return { duplicate: true, written: 0, dropped: 0 };
        }
        let written = 0, dropped = 0;
        for (const raw of entries) {
            const e = validEntry(raw, now);
            if (!e || !s.nodeExists.get(e.nodeId)) { dropped++; continue; }
            s.add.run(e.nodeId, e.hour, e.activity, e.ms);
            written++;
        }
        return { duplicate: false, written, dropped };
    }).immediate();
    const [from, to] = dayRange(date);
    return { ...result, date, todayMs: s.dayTotal.get(from, to).ms };
}

/** The `n` UTC days ending on `endDay`, oldest first. */
function dayList(endDay, n) {
    const end = Date.parse(`${endDay}T00:00:00Z`);
    return Array.from({ length: n }, (_, i) => dayOf(end - (n - 1 - i) * DAY_MS));
}

/** `n` days ending on `endDay` across the library, oldest first, each with its milliseconds (0 kept). */
export function recentDays(endDay, n) {
    const days = dayList(endDay, n);
    const rows = statements().daysBetween.all(`${days[0]}T00`, `${endDay}T23`);
    const byDay = new Map(rows.map(r => [r.day, r.ms]));
    return days.map(day => ({ day, ms: byDay.get(day) || 0 }));
}

/**
 * One UTC day across the library: the total, what it was spent doing, and
 * every topic it went to. The split is what answers "59 minutes, and nothing
 * done?" on a day spent reading — the day's counters only count what was
 * FINISHED.
 */
export function dayStudyTime(day) {
    const [from, to] = dayRange(day);
    const s = statements();
    return {
        totalMs: s.dayTotal.get(from, to).ms,
        byActivity: Object.fromEntries(s.dayActivities.all(from, to).map(r => [r.activity, r.ms])),
        topics: s.dayTopics.all(from, to),
    };
}

/** Fold `{day, activity, ms}` rows into a total, a per-activity split and a per-day list. */
function summarise(rows) {
    const byActivity = {};
    const byDay = new Map();
    let totalMs = 0;
    for (const r of rows) {
        totalMs += r.ms;
        byActivity[r.activity] = (byActivity[r.activity] || 0) + r.ms;
        byDay.set(r.day, (byDay.get(r.day) || 0) + r.ms);
    }
    const days = [...byDay].map(([day, ms]) => ({ day, ms })).sort((a, b) => (a.day < b.day ? 1 : -1));
    return {
        totalMs,
        byActivity,
        days,
        studyDays: days.length,
        firstDay: days.length ? days[days.length - 1].day : null,
        lastDay: days.length ? days[0].day : null,
    };
}

/**
 * A topic, or a section with everything under it.
 *
 * `predates` says the course is older than the clock, so the panel can say
 * "counted since" rather than present a part as the whole.
 */
export function nodeStudyTime(nodeId) {
    const s = statements();
    const node = s.node.get(Number(nodeId));
    if (!node) return null;
    const sum = summarise(s.subtreeRows.all(node.id));
    return {
        ...sum,
        days: sum.days.slice(0, TOPIC_DAYS_SHOWN),
        moreDays: Math.max(0, sum.days.length - TOPIC_DAYS_SHOWN),
        countedSince: studyTimeSince(),
        predates: predatesClock(node.projectCreated),
    };
}

/** A project: the total, the last `recent` days, and where the time went. */
export function projectStudyTime(projectId, { today = dayOf(Date.now()), recent = 14 } = {}) {
    const s = statements();
    const project = s.project.get(Number(projectId));
    if (!project) return null;
    const sum = summarise(s.projectRows.all(project.id));
    const byDay = new Map(sum.days.map(d => [d.day, d.ms]));
    return {
        totalMs: sum.totalMs,
        byActivity: sum.byActivity,
        studyDays: sum.studyDays,
        firstDay: sum.firstDay,
        lastDay: sum.lastDay,
        bestDay: sum.days.reduce((best, d) => (!best || d.ms > best.ms ? { date: d.day, ms: d.ms } : best), null),
        recent: dayList(today, recent).map(day => ({ day, ms: byDay.get(day) || 0 })),
        topics: s.projectTopics.all(project.id),
        countedSince: studyTimeSince(),
        predates: predatesClock(project.created_at),
    };
}
