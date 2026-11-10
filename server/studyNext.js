/**
 * What to study next, read off the atlas: in a course the learner is working
 * through now, the topic not yet started that is closest in meaning to one
 * they have already finished in the same region.
 *
 * The atlas already knows both halves — where every topic sits in meaning
 * (its vector) and what the learner has closed (its status) — so the hint is
 * arithmetic over the build, with no model call and no clock. "Now" is the
 * library's own latest finish rather than today's date: a course counts as
 * current when it closed something within `windowDays` of the newest finish
 * anywhere, so a learner back from a month away still gets the courses they
 * were in the middle of, and a gate gets the same answer on any day.
 *
 * One suggestion per region, best first: three topics from one place is one
 * suggestion said three times.
 */
import { cleanRegionLabel } from './curriculumLabel.js';

const DAY_MS = 86400000;
// Multiply-adds between event-loop yields: a few milliseconds of work, so a
// large library's comparison never holds up another request for long.
const WORK_PER_YIELD = 1 << 21;
const nextTick = () => new Promise(resolve => setImmediate(resolve));

/**
 * @param {{ members: { id: number, status: string, project_id: number,
 *   completed_iso?: string|null, is_leaf?: number|boolean, vec: ArrayLike<number>,
 *   title: string }[] }[]} regions the atlas's regions, in build order; a
 *   suggestion's `regionId` is the index into this list, which is the id the
 *   build gives each region.
 * @param {object} [opts]
 * @param {{ project_id: number, completed_iso: string|null }[]} [opts.finishes]
 *   each course's latest finish over the whole library, with or without a
 *   vector; without it the finishes are read off the regions' members.
 * @returns {Promise<{ topicId: number, regionId: number, nearId: number,
 *   nearTitle: string, similarity: number }[]>}
 */
export async function studyNext(regions, { limit = 3, windowDays = 21, finishes = null } = {}) {
    if (!(limit > 0)) return [];
    // The courses under way: each one's latest finish, against the newest.
    // A finished topic with no vector yet is not on the map but still says
    // which course the learner is in, so the build passes every finish.
    const lastBy = new Map();
    const finished = finishes || regions.flatMap(r => r.members.filter(m => m.status === 'completed'));
    for (const m of finished) {
        if (!m.completed_iso) continue;
        const at = Date.parse(m.completed_iso);
        if (!Number.isFinite(at)) continue;
        if (!(lastBy.get(m.project_id) >= at)) lastBy.set(m.project_id, at);
    }
    if (!lastBy.size) return [];
    const newest = Math.max(...lastBy.values());
    const current = new Set([...lastBy].filter(([, at]) => newest - at <= windowDays * DAY_MS).map(([p]) => p));

    const candidates = [];
    let work = 0;
    for (let regionId = 0; regionId < regions.length; regionId++) {
        const r = regions[regionId];
        const done = r.members.filter(m => m.status === 'completed' && m.vec?.length);
        if (!done.length) continue;
        for (const m of r.members) {
            // A heading is not something to study; its topics are.
            if (m.status !== 'not_started' || !m.is_leaf || !current.has(m.project_id) || !m.vec?.length) continue;
            // Begun is not next: an answer given or a card met is work under
            // way, as the region's own counts say, whatever the status reads.
            if (m.attempts > 0 || m.sub?.seen > 0) continue;
            let best = -Infinity, near = null;
            for (const d of done) {
                let s = 0;
                const n = Math.min(m.vec.length, d.vec.length);
                for (let k = 0; k < n; k++) s += m.vec[k] * d.vec[k];
                if (s > best || (near && s === best && d.id < near.id)) { best = s; near = d; }
                work += n;
            }
            if (work >= WORK_PER_YIELD) { work = 0; await nextTick(); }
            // A vector that is not numbers (NaN) is near nothing.
            if (!near) continue;
            candidates.push({ topicId: m.id, regionId, nearId: near.id, nearTitle: cleanRegionLabel(near.title), score: best });
        }
    }
    // Ranked on the full score: two topics a rounding apart are not a tie.
    candidates.sort((a, b) => b.score - a.score || a.topicId - b.topicId);
    const out = [], seen = new Set();
    for (const { score, ...c } of candidates) {
        if (out.length >= limit) break;
        if (seen.has(c.regionId)) continue;
        seen.add(c.regionId);
        out.push({ ...c, similarity: Number(score.toFixed(4)) });
    }
    return out;
}
