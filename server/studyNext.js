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

/**
 * @param {{ members: { id: number, status: string, project_id: number,
 *   completed_iso?: string|null, is_leaf?: number|boolean, vec: ArrayLike<number>,
 *   title: string }[] }[]} regions the atlas's regions, in build order; a
 *   suggestion's `regionId` is the index into this list, which is the id the
 *   build gives each region.
 * @returns {{ topicId: number, regionId: number, nearId: number,
 *   nearTitle: string, similarity: number }[]}
 */
export function studyNext(regions, { limit = 3, windowDays = 21 } = {}) {
    // The courses under way: each one's latest finish, against the newest.
    const lastBy = new Map();
    for (const r of regions) for (const m of r.members) {
        if (m.status !== 'completed' || !m.completed_iso) continue;
        const at = Date.parse(m.completed_iso);
        if (!Number.isFinite(at)) continue;
        if (!(lastBy.get(m.project_id) >= at)) lastBy.set(m.project_id, at);
    }
    if (!lastBy.size) return [];
    const newest = Math.max(...lastBy.values());
    const current = new Set([...lastBy].filter(([, at]) => newest - at <= windowDays * DAY_MS).map(([p]) => p));

    const candidates = [];
    regions.forEach((r, regionId) => {
        const done = r.members.filter(m => m.status === 'completed');
        if (!done.length) return;
        for (const m of r.members) {
            // A heading is not something to study; its topics are.
            if (m.status !== 'not_started' || !m.is_leaf || !current.has(m.project_id)) continue;
            let best = -Infinity, near = null;
            for (const d of done) {
                let s = 0;
                const n = Math.min(m.vec.length, d.vec.length);
                for (let k = 0; k < n; k++) s += m.vec[k] * d.vec[k];
                if (s > best || (s === best && d.id < near.id)) { best = s; near = d; }
            }
            candidates.push({
                topicId: m.id,
                regionId,
                nearId: near.id,
                nearTitle: cleanRegionLabel(near.title),
                similarity: Number(best.toFixed(4)),
            });
        }
    });
    candidates.sort((a, b) => b.similarity - a.similarity || a.topicId - b.topicId);
    const out = [], seen = new Set();
    for (const c of candidates) {
        if (seen.has(c.regionId)) continue;
        seen.add(c.regionId);
        out.push(c);
        if (out.length >= limit) break;
    }
    return out;
}
