// server/capacity.js — one capacity for the whole library, read out of it.
//
// The arithmetic is `shareCapacity` in server/paceModel.js (pure); this file
// gathers its facts: every active course's verdict (server/pace.js), its unit,
// and whether the learner paused it. The capacity of a unit is the best pace
// the learner has held in it, once there are enough weeks to judge one.
//
// Read by the feed (which courses get new work, in which order), the feed
// header's deadline chip and the schedule overview, so the three cannot rank
// the library differently.
import db from './database.js';
import { projectCountsInCards } from './progress.js';
import { libraryPace, projectVerdict } from './pace.js';
import { learnerTimeZone } from './studyDay.js';
import { VERDICT_FROM_WEEKS, shareCapacity } from './paceModel.js';

let activeStmt = null;

const bestOf = (pace) => (pace.weeksOfData >= VERDICT_FROM_WEEKS ? pace.best : null);

/**
 * The library's week: each active course's verdict and its place in the queue.
 *
 * @param {{ now?: number, timeZone?: string, library?: ReturnType<typeof libraryPace>, offers?: boolean }} [opts]
 *   `offers: true` judges each verdict with its full offer list (the plan
 *   screens); the feed reads only bands and leaves the placement probe out.
 * @returns {{ today: string, order: number[], courses: Map<number, { status: string, share: number|null,
 *   rank: number|null, verdict: object|null, unit: 'topics'|'cards' }>, units: object }}
 */
export function libraryCapacity({ now = Date.now(), timeZone = learnerTimeZone(), library = null, offers = false } = {}) {
    activeStmt ??= db.prepare(`
        SELECT id, deadline, COALESCE(paused, 0) AS paused FROM live_projects projects
        WHERE COALESCE(status, 'active') = 'active'
        ORDER BY position ASC, created_at ASC, id ASC
    `);
    const lib = library || libraryPace({ now, timeZone });
    const facts = activeStmt.all().map((p) => {
        const verdict = p.deadline ? projectVerdict(p.id, { now, timeZone, library: lib, offers }) : null;
        const unit = verdict?.unit || (projectCountsInCards(p.id) ? 'cards' : 'topics');
        return {
            id: p.id,
            unit,
            band: verdict?.band || 'no_date',
            needed: verdict?.needed ?? null,
            deadline: verdict?.deadline ?? null,
            paused: Boolean(p.paused),
            verdict,
        };
    });
    // A unit's record is read only when a dated course counts in it: a
    // library with no dated deck never runs the review log's window query.
    const datedIn = (unit) => facts.some(f => f.deadline && f.unit === unit);
    const shared = shareCapacity(facts, {
        topics: datedIn('topics') ? bestOf(lib.topics) : null,
        cards: datedIn('cards') ? bestOf(lib.cards) : null,
    });
    const courses = new Map();
    for (const f of facts) courses.set(f.id, { ...shared.courses.get(f.id), verdict: f.verdict, unit: f.unit });
    return { today: lib.today, order: shared.order, courses, units: shared.units };
}

/**
 * The chip's old three-step status, from a verdict: what an older screen
 * colours by. Out of reach (or gone by) is critical; any band that misses, or
 * a first week that already needs twice the pace, is falling behind.
 */
export function paceStatusOf(verdict) {
    const band = verdict?.band;
    if (band === 'out_of_reach' || band === 'passed') return 'critical';
    if (band === 'tight' || band === 'under_pace' || (band === 'learning' && verdict.early)) return 'falling_behind';
    return 'on_track';
}

const SEVERITY = { passed: 5, out_of_reach: 4, tight: 3, under_pace: 2, learning: 1, on_pace: 0 };

/** How hard a verdict presses, for ranking dated courses against each other. */
export function severityOf(verdict) {
    if (!verdict) return -1;
    if (verdict.band === 'learning') return verdict.early ? 2 : 0;
    return SEVERITY[verdict.band] ?? -1;
}
