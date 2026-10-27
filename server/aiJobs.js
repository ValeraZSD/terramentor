/* Which model does each kind of AI work, and what answers when it fails.
 *
 * SEVEN JOBS, NAMED BY WHAT THE LEARNER SEES. An operation (`structure`,
 * `verify`, ...) says how hard to think and how long to wait; a JOB says which
 * model. They stay separate so routing a job never changes the wire a call
 * sends: the effort and the timeout still follow the operation.
 *
 * A JOB'S LIST is its own models, tried in order: the next one only when the
 * one before it failed in a way another model could fix (`fallsOver`). A job
 * with no list uses the main model (the connection in use, `getAISettings()`)
 * and then the `backups` list. A job with a list uses ONLY that list: a
 * learner who sent their questions to the model on this computer has said
 * where that text may go, and the backups must not carry it elsewhere.
 *
 * NOTHING CHANGES UNTIL A CHOICE IS MADE. With no rows the chain is exactly
 * `[getAISettings()]`, the same object every call read before this file
 * existed, so a library that never opened the per-job screen sends the same
 * bytes to the same place.
 *
 * A batch tool's env override (AI_PROVIDER / AI_BASE_URL / AI_MODEL) wins over
 * every list: a sweep pointed at a local engine must never reach the learner's
 * cloud keys through a job's route.
 */
import db from './database.js';
import { getAISettings, REASONING_EFFORTS } from './ai.js';
import { settingsForConnection } from './aiConnections.js';

/** Every job, in the order the settings screen lists them. */
export const AI_JOBS = ['conversation', 'courses', 'lessons', 'questions', 'checks', 'vision', 'small'];

/** Not a job: the list behind the main model, for every job without its own. */
export const BACKUPS = 'backups';

/** A list is a first choice and at most four backups. */
export const MAX_ROUTE = 5;

/** The job an operation belongs to when its caller names none. */
const JOB_OF_OPERATION = {
    chat: 'conversation',
    explain: 'conversation',
    structure: 'courses',
    project_identity: 'courses',
    search_words: 'courses',
    authoring: 'lessons',
    insights: 'lessons',
    questions: 'questions',
    capture: 'questions',
    verify: 'checks',
    assistant_check: 'checks',
    vision: 'vision',
    summary: 'small',
};

/** The job a call runs as: the one it names, else its operation's, else `small`. */
export function jobOf({ job, operation } = {}) {
    if (AI_JOBS.includes(job)) return job;
    return JOB_OF_OPERATION[operation] || 'small';
}

const envOverride = () => !!(process.env.AI_PROVIDER || process.env.AI_BASE_URL || process.env.AI_MODEL);

const bad = (message) => Object.assign(new Error(message), { status: 400 });

/** Every job's list (and the backups), `{ connectionId, model, effort }` in order. */
export function getJobRoutes() {
    const out = Object.fromEntries([...AI_JOBS, BACKUPS].map(j => [j, []]));
    const rows = db.prepare('SELECT job, connection_id, model, effort FROM ai_job_routes ORDER BY job, position').all();
    for (const r of rows) out[r.job]?.push({ connectionId: r.connection_id, model: r.model, effort: r.effort });
    return out;
}

/** Replace one job's list. An empty list gives the job back to the main model. */
export function setJobRoute(job, route) {
    if (![...AI_JOBS, BACKUPS].includes(job)) throw bad('Unknown job');
    if (!Array.isArray(route)) throw bad('A route is a list');
    if (route.length > MAX_ROUTE) throw bad(`A job takes at most ${MAX_ROUTE} models`);
    const entries = route.map((e) => {
        const connectionId = Number(e?.connectionId);
        if (!Number.isInteger(connectionId) || !db.prepare('SELECT 1 FROM ai_connections WHERE id = ?').get(connectionId)) {
            throw bad('No such connection');
        }
        const model = typeof e?.model === 'string' ? e.model.trim().slice(0, 200) : '';
        const effort = typeof e?.effort === 'string' ? e.effort : '';
        if (effort && !REASONING_EFFORTS.includes(effort)) throw bad('Unknown thinking level');
        return { connectionId, model, effort };
    });
    db.transaction(() => {
        db.prepare('DELETE FROM ai_job_routes WHERE job = ?').run(job);
        const put = db.prepare('INSERT INTO ai_job_routes (job, position, connection_id, model, effort) VALUES (?, ?, ?, ?, ?)');
        entries.forEach((e, i) => put.run(job, i, e.connectionId, e.model, e.effort));
    })();
}

/** Every job back on the main model, and no backups. */
export function clearJobRoutes() {
    db.prepare('DELETE FROM ai_job_routes').run();
}

/** One list entry as the settings object a model call reads, or null when its
 *  connection is gone. An entry's own thinking level replaces the stored one;
 *  '' is automatic (by operation, `effortFor`). */
function entrySettings(entry) {
    const s = settingsForConnection(entry.connectionId, { model: entry.model || undefined });
    if (!s) return null;
    return { ...s, reasoningEffort: entry.effort || '' };
}

/**
 * The settings objects a call tries, in order. `model` is the caller's own
 * override for this one call (an atlas naming model, a vision model), which
 * applies to the main model the way it always has; a job's own list wins
 * over it, since that is the newer and more specific choice.
 */
export function chainFor(job, { model = null } = {}) {
    const main = getAISettings();
    const first = model ? { ...main, model } : main;
    if (envOverride()) return [first];
    const routes = getJobRoutes();
    const own = (routes[job] || []).map(entrySettings).filter(Boolean);
    if (own.length) return own;
    return [first, ...routes[BACKUPS].map(entrySettings).filter(Boolean)];
}

/** The settings a job's first choice runs on: what a check made BEFORE the
 *  call (can it see pictures, does it take native tools) must ask about. */
export function firstChoice(job, { model = null } = {}) {
    return chainFor(job, { model })[0];
}

const TRANSPORT =/^(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE|UND_ERR_[A-Z_]+)$/;

/**
 * Whether the next model in the list may take this call over. Yes for what
 * another model could fix: a status the endpoint answered with (busy after the
 * retries, down, out of credit, a refused key, an unknown model), an endpoint
 * that could not be reached, a non-streamed empty reply. Never for a cancel or
 * a timeout (the caller's own deadline, already spent), a reasoning loop, or
 * an error nobody recognises — those are answers about the call, and sending
 * it again elsewhere would spend twice for the same result.
 */
export function fallsOver(err, signal) {
    if (!err || typeof err !== 'object') return false;
    if (signal?.aborted) return false;
    if (err.name === 'AbortError' || err.name === 'TimeoutError' || err.looped) return false;
    if (err.emptyReply) return true;
    const status = Number(err.httpStatus ?? err.status_code);
    if (Number.isInteger(status) && status >= 400 && status <= 599) return true;
    const code = [err.code, err.cause?.code].find(c => typeof c === 'string');
    if (code && TRANSPORT.test(code)) return true;
    return err instanceof TypeError && /fetch failed/i.test(err.message || '');
}
