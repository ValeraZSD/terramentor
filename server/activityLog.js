// server/activityLog.js — the local record of what the app did.
//
// The console already narrated every model call, every background job and every
// migration; it just narrated them to a terminal nobody has open. The result is
// that the only way to answer "what happened before it broke" was to ask the
// person to make it happen again — which, for the two things worth diagnosing
// (an intermittent stall, a model that started refusing), is the one thing they
// cannot do on demand.
//
// So the same events are appended here as rows, and Settings → Data shows the
// tail of them and offers the file. Three uses, in the order they matter:
// looking at what just happened, handing a developer a file that says what the
// app did rather than what the reporter remembers, and giving a coding agent
// something to read when the person debugging their own copy is an LLM.
//
// **No learner content, ever** — see the table comment in database.js. Every
// writer here passes an area, a verb, an optional duration and a short
// technical `detail`; ids travel as ids. `sanitizeDetail` is the backstop, not
// the policy: the policy is that call sites do not have the content to give.
//
// Writing is synchronous (better-sqlite3) and wrapped so a logging failure can
// never take down the thing being logged: a log that can break the app is worse
// than no log. Retention is a row cap, trimmed amortised — the table is a
// ring buffer, not an archive, because an unbounded log on a local disk is a
// bug that shows up months later as a database nobody can back up.

import db from './database.js';

/** Rows kept. At ~120 bytes a row this is a couple of megabytes at the cap. */
export const MAX_ROWS = Number(process.env.ACTIVITY_LOG_MAX) || 20000;

/** Trim every N inserts rather than on each one: a DELETE with a subquery per
 *  row would cost more than everything being logged. */
const TRIM_EVERY = 250;

/** Longest `detail` kept. A provider's error body can be a page of HTML. */
const DETAIL_MAX = 400;

const LEVELS = new Set(['info', 'warn', 'error']);

let sinceTrim = 0;
let enabled = null; // resolved lazily from settings, cached until invalidated

function readEnabledSetting() {
    try {
        const row = db.prepare(`SELECT value FROM settings WHERE key = 'activity_log_enabled'`).get();
        // Absent means ON: a diagnostic that has to be switched on before the
        // thing you are diagnosing happens has already missed it.
        return !row || row.value !== 'false';
    } catch {
        return true;
    }
}

/** Called by the settings route when the switch is flipped. */
export function invalidateActivityLogSetting() {
    enabled = null;
}

export function activityLogEnabled() {
    if (enabled === null) enabled = readEnabledSetting();
    return enabled;
}

/**
 * Last-line defence for `detail`: one line, bounded, no control bytes.
 *
 * It cannot tell a topic title from a model id, and is not trying to — the
 * guarantee comes from the call sites. What it does stop is a multi-kilobyte
 * provider error or a stack trace turning one row into the size of the rest of
 * the table, and a stray newline making the exported file unparseable per line.
 */
export function sanitizeDetail(value) {
    if (value == null) return null;
    const flat = String(value).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    if (!flat) return null;
    return flat.length > DETAIL_MAX ? `${flat.slice(0, DETAIL_MAX - 1)}…` : flat;
}

const insert = () => db.prepare(`
    INSERT INTO activity_log (at, level, area, event, detail, ms, project_id, node_id)
    VALUES (@at, @level, @area, @event, @detail, @ms, @projectId, @nodeId)
`);

let insertStmt = null;

/**
 * Append one event. Never throws, never blocks, returns nothing worth checking.
 *
 * @param {object} e
 * @param {string} e.area    which part of the app — ai | task | project | vault | server | feed | deck
 * @param {string} e.event   a short verb, machine-readable: 'ai.request', 'task.failed', 'project.created'
 * @param {'info'|'warn'|'error'} [e.level]
 * @param {string} [e.detail] ONE short technical line. No titles, prompts or output.
 * @param {number} [e.ms]     how long it took, where that is a fact and not an estimate
 * @param {number} [e.projectId]
 * @param {number} [e.nodeId]
 */
export function logActivity(e) {
    try {
        if (!e || !e.area || !e.event) return;
        if (!activityLogEnabled()) return;
        if (!insertStmt) insertStmt = insert();
        insertStmt.run({
            at: new Date().toISOString(),
            level: LEVELS.has(e.level) ? e.level : 'info',
            area: String(e.area).slice(0, 32),
            event: String(e.event).slice(0, 64),
            detail: sanitizeDetail(e.detail),
            ms: Number.isFinite(e.ms) ? Math.round(e.ms) : null,
            projectId: Number.isFinite(e.projectId) ? e.projectId : null,
            nodeId: Number.isFinite(e.nodeId) ? e.nodeId : null,
        });
        if (++sinceTrim >= TRIM_EVERY) {
            sinceTrim = 0;
            trimActivityLog();
        }
    } catch { /* a log that can break the app is worse than no log */ }
}

/** Drop everything older than the newest MAX_ROWS rows. */
export function trimActivityLog() {
    try {
        db.prepare(`
            DELETE FROM activity_log
            WHERE id <= (SELECT MAX(id) FROM activity_log) - ?
        `).run(MAX_ROWS);
    } catch { /* housekeeping */ }
}

/**
 * The tail, newest first, for the panel.
 *
 * `project_id` is resolved to a name HERE, on the way to the screen, and never
 * stored — the reader is looking at their own machine, the file they might send
 * is not. A project that has since been deleted resolves to nothing, which is
 * itself the answer to "what happened to it".
 */
export function readActivity({ limit = 50, level = null, area = null, before = null } = {}) {
    const where = [];
    const params = {};
    if (level === 'problems') where.push(`a.level IN ('warn','error')`);
    else if (level && LEVELS.has(level)) { where.push('a.level = @level'); params.level = level; }
    if (area) { where.push('a.area = @area'); params.area = area; }
    if (before) { where.push('a.id < @before'); params.before = before; }
    params.limit = Math.min(Math.max(Number(limit) || 50, 1), 500);
    const rows = db.prepare(`
        SELECT a.id, a.at, a.level, a.area, a.event, a.detail, a.ms, a.project_id, a.node_id,
               p.name AS project_title
        FROM activity_log a
        LEFT JOIN projects p ON p.id = a.project_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY a.id DESC
        LIMIT @limit
    `).all(params);
    return rows.map(r => ({
        id: r.id,
        at: r.at,
        level: r.level,
        area: r.area,
        event: r.event,
        detail: r.detail,
        ms: r.ms,
        projectId: r.project_id,
        nodeId: r.node_id,
        projectTitle: r.project_title || null,
    }));
}

/** How many rows there are, and how far back they go. */
export function activityStats() {
    try {
        const row = db.prepare(`
            SELECT COUNT(*) AS rows, MIN(at) AS oldest, MAX(at) AS newest,
                   SUM(CASE WHEN level IN ('warn','error') THEN 1 ELSE 0 END) AS problems
            FROM activity_log
        `).get();
        return {
            rows: row?.rows || 0,
            problems: row?.problems || 0,
            oldest: row?.oldest || null,
            newest: row?.newest || null,
            max: MAX_ROWS,
            enabled: activityLogEnabled(),
        };
    } catch {
        return { rows: 0, problems: 0, oldest: null, newest: null, max: MAX_ROWS, enabled: activityLogEnabled() };
    }
}

/**
 * The whole log as text, oldest first, one event per line.
 *
 * Plain text rather than JSON because of who reads it: a person scanning for
 * the minute something went wrong, and a coding agent being handed the file in
 * a prompt. Both do better with `12:04:11 warn  ai  ai.request  …` than with
 * 20,000 objects. The columns are fixed-width so a diff of two runs lines up.
 *
 * Streamed in pages: the export of a full table must not build a 20k-element
 * string array in memory on a machine that is already the constraint.
 */
export function* streamActivityLog({ pageSize = 1000 } = {}) {
    const stats = activityStats();
    yield `# Terramentor activity log — ${stats.rows} event(s)\n`;
    yield `# exported ${new Date().toISOString()}\n`;
    yield '# No topic titles, prompts, notes or model output are recorded here — only what the software did.\n';
    yield '# time                     level area     event                detail\n';
    const page = db.prepare(`
        SELECT id, at, level, area, event, detail, ms, project_id, node_id
        FROM activity_log WHERE id > ? ORDER BY id ASC LIMIT ?
    `);
    let after = 0;
    for (;;) {
        const rows = page.all(after, pageSize);
        if (!rows.length) return;
        let chunk = '';
        for (const r of rows) {
            const bits = [];
            if (r.ms != null) bits.push(`${r.ms}ms`);
            if (r.project_id != null) bits.push(`project=${r.project_id}`);
            if (r.node_id != null) bits.push(`node=${r.node_id}`);
            if (r.detail) bits.push(r.detail);
            chunk += `${r.at} ${r.level.padEnd(5)} ${String(r.area).padEnd(8)} ${String(r.event).padEnd(20)} ${bits.join(' · ')}\n`;
            after = r.id;
        }
        yield chunk;
    }
}

export function clearActivityLog() {
    try {
        db.exec('DELETE FROM activity_log');
        return true;
    } catch {
        return false;
    }
}
