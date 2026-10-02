import db from './database.js';
import { WORK_LEAF } from './today.js';
import { teachingText } from './lessonSources.js';

/**
 * Where a topic sits in its course, for the feed's lesson writer.
 *
 * `buildNodeContext` (ai.js) hands an author ONE topic: its material, its path,
 * the titles the learner has completed. What it never said is what comes just
 * before and just after, or how long ago the learner was there — so a lesson on
 * Doppler could not know that Beats came right before it, and could not know
 * that "right before" was seven weeks ago. The first gap makes a lesson that
 * starts from nothing; the second makes one that says "as you just learned"
 * about something the learner last saw in July.
 *
 * So this is two halves, and only the lesson writer gets them:
 *
 *   1. A few topics either side, in COURSE ORDER (the order the tree renders
 *      in — depth-first by position, work leaves only), each with its section
 *      path and, for the learner, one of: finished N weeks ago, started and
 *      last studied N days ago, skipped, not studied yet.
 *   2. The immediately previous topic's material AS THE LEARNER WAS SHOWN IT —
 *      the lessons they actually scrolled past in the feed, visuals stripped —
 *      or its Overview and Material when nothing of it was served (a closed
 *      topic's feed cache is deleted at startup, so for a finished topic this
 *      is the usual case). Bounded, trimmed, never summarised by a model.
 *
 * The block states its own rules, the way the retrieved-sources block does:
 * orientation only, never "as you just learned", refer back neutrally and only
 * where it helps, do not pre-empt the later topics, and never write about the
 * order, the dates or anyone's progress.
 *
 * NOT given to the question writer, the mastery-check bank or the cards
 * (`generateMaterial`). Assessment stays pinned to its topic — the rule the
 * completed-topics list already follows — and a list of neighbouring titles
 * with dates beside them is exactly the kind of filing a question writer turns
 * into "which topic did you finish three weeks ago?" (`scaffoldingFaults` in
 * feedQuality.js knows this block's phrasing for the day one leaks anyway).
 *
 * Pure where it can be: `formatCourseContext` and `recencyPhrase` take plain
 * data and an injected clock, so a gate can pin the wording without a database.
 */

export const NEIGHBOURS_BEFORE = 3;
export const NEIGHBOURS_AFTER = 2;
/** The previous topic's text, at most. Roughly two lesson parts. */
export const PREVIOUS_TOPIC_CHARS = 2400;
const TITLE_CHARS = 120;
const TRAIL_CHARS = 120;
const DAY_MS = 86_400_000;

// Visual specs are for the renderer, not for the next author: what was TAUGHT
// matters, a stripped SVG does not. Real code blocks stay — in a programming
// course the code is the running example. Same set feedGen strips from the
// earlier parts of a topic.
const SPEC_FENCES = /^```(mermaid|vega-lite|vega|plot|animation|p5|widget|drill|smiles|svg)\b[\s\S]*?^```/gm;

/**
 * A timestamp as milliseconds, from either shape this database writes: the ISO
 * form JS writes (`2026-09-27T19:26:38.584Z`) and SQLite's CURRENT_TIMESTAMP
 * (`2026-09-27 19:26:38`, which is UTC and must not be read as local time).
 */
export function parseStamp(value) {
    if (!value) return null;
    const s = String(value).trim();
    const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s) ? `${s.replace(' ', 'T')}Z` : s;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : null;
}

/**
 * How long ago, in the coarse words a person uses — never a date, which would
 * invite the author to write one. Null for a missing or future stamp.
 */
export function recencyPhrase(stampMs, nowMs) {
    if (stampMs == null || nowMs == null || !Number.isFinite(stampMs) || !Number.isFinite(nowMs)) return null;
    if (nowMs - stampMs < 0) return null;
    // CALENDAR days in UTC, the app's study-day boundary: twenty hours ago
    // across a midnight is "yesterday", not "today".
    const days = Math.floor(nowMs / DAY_MS) - Math.floor(stampMs / DAY_MS);
    if (days === 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 14) return `${days} days ago`;
    if (days < 60) return `${Math.round(days / 7)} weeks ago`;
    if (days < 365) return `${Math.max(2, Math.round(days / 30))} months ago`;
    const years = Math.floor(days / 365);
    return years === 1 ? 'over a year ago' : `${years} years ago`;
}

/** Where the learner stands with one neighbouring topic, as one phrase. */
export function learnerStanding(topic, nowMs) {
    if (topic.status === 'completed') {
        const when = recencyPhrase(parseStamp(topic.completedAt), nowMs);
        return when ? `finished ${when}` : 'finished';
    }
    if (topic.status === 'skipped') return 'skipped';
    const last = recencyPhrase(parseStamp(topic.lastStudiedAt), nowMs);
    if (last) return `started, last studied ${last}`;
    return 'not studied yet';
}

const clip = (s, n) => {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

/**
 * At most `max` characters of `text`, cut on a paragraph (else a line, else a
 * word) so the author is never handed half a sentence as if it were whole.
 * `from: 'end'` keeps the TAIL — for lessons, whose end is what immediately
 * preceded this topic; `'start'` keeps the head — for an Overview, whose first
 * lines say what the topic is.
 */
export function boundText(text, max, from = 'end') {
    const t = String(text || '').trim();
    if (t.length <= max) return t;
    if (from === 'start') {
        const cut = t.slice(0, max);
        const at = Math.max(cut.lastIndexOf('\n\n'), cut.lastIndexOf('\n'));
        const end = at > max * 0.5 ? at : Math.max(cut.lastIndexOf(' '), max * 0.8);
        return `${cut.slice(0, end).trimEnd()} […]`;
    }
    const cut = t.slice(t.length - max);
    const para = cut.indexOf('\n\n');
    const line = cut.indexOf('\n');
    const start = para !== -1 && para < max * 0.5 ? para + 2
        : line !== -1 && line < max * 0.5 ? line + 1
            : Math.max(0, cut.indexOf(' ') + 1);
    return `[…] ${cut.slice(start).trimStart()}`;
}

/** The previous topic's lessons as served, visuals stripped, in reading order. */
export function shownLessonText(lessonContents) {
    return (lessonContents || [])
        .map(c => String(c || '').replace(SPEC_FENCES, '[visual]').trim())
        .filter(Boolean)
        .join('\n\n');
}

/**
 * The block itself, from plain data. Returns '' when there is nothing to say (a
 * one-topic course, a node that is not in its course's order).
 *
 * @param {{
 *   before: Array<{title:string, trail?:string, status?:string, completedAt?:string|null, lastStudiedAt?:string|null}>,
 *   current: {title:string, trail?:string},
 *   after: Array<{title:string, trail?:string, status?:string, completedAt?:string|null, lastStudiedAt?:string|null}>,
 *   previous?: {title:string, source:'shown'|'overview', text:string, status?:string, completedAt?:string|null, lastStudiedAt?:string|null}|null,
 *   isFirst?: boolean, isLast?: boolean,
 * }} data
 * @param {{ now?: number, maxPreviousChars?: number }} [opts]
 */
export function formatCourseContext(data, { now = Date.now(), maxPreviousChars = PREVIOUS_TOPIC_CHARS } = {}) {
    if (!data || !data.current) return '';
    const before = data.before || [];
    const after = data.after || [];
    if (!before.length && !after.length) return '';

    // The section is said once, on this topic's line; a neighbour repeats it
    // only when it lives in a different one. Six copies of "Domain B — … › B1
    // — …" are a third of the list and say nothing the first did not.
    const home = data.current.trail || '';
    const line = (t) => {
        const where = t.trail && t.trail !== home ? `${clip(t.trail, TRAIL_CHARS)} › ` : '';
        return `- ${where}${clip(t.title, TITLE_CHARS)} (${learnerStanding(t, now)})`;
    };

    const out = [
        '',
        'WHERE THIS TOPIC SITS IN ITS COURSE — orientation for you, the author. It is not material to teach, and nothing in it is ever something to write about.',
        'The learner moves through the course at their own pace: an earlier topic may have been finished weeks ago, or never studied at all. So:',
        '- Never assume an earlier topic is fresh in their mind. Do not write "as you just learned", "last time", "in the previous lesson", "you have already seen" or anything like them. Where an earlier idea genuinely helps, recall it briefly and neutrally ("earlier in the course…", "recall that…") and restate the one fact you need — do not lean on it unexplained.',
        '- Do not teach or pre-empt the later topics; they get their own lessons.',
        '- Never mention this list, the order of the course, dates, or anyone\'s progress.',
    ];
    if (home) out.push(`Section: ${clip(home, TRAIL_CHARS)} (topics below are in it unless a path is given)`);
    if (before.length) out.push('Earlier in the course:', ...before.map(line));
    else if (data.isFirst) out.push('This is the first topic of the course.');
    out.push(`This topic: ${clip(data.current.title, TITLE_CHARS)}`);
    if (after.length) out.push('Later in the course:', ...after.map(line));
    else if (data.isLast) out.push('This is the last topic of the course.');

    const prev = data.previous;
    const text = prev?.text ? boundText(prev.text, maxPreviousChars, prev.source === 'shown' ? 'end' : 'start') : '';
    if (text) {
        const how = prev.source === 'shown'
            ? 'as the learner was shown it in the feed'
            : 'its Overview and Material (its lessons are no longer on record)';
        out.push(
            `The previous topic, "${clip(prev.title, TITLE_CHARS)}" (${learnerStanding(prev, now)}), ${how} — for continuity of notation and examples only; do not repeat it:`,
            '"""',
            text,
            '"""',
        );
    }
    return `${out.join('\n')}\n`;
}

// ---- the database half ---------------------------------------------------------

/**
 * Every work leaf of a project in course order, with its section trail. One
 * recursive query: the position is per parent, so the order is the tree walk
 * and never a sort on `position` (which interleaves every section's first
 * topics). Ties on position fall back to id so the order is stable.
 */
export function courseLeaves(projectId) {
    return db.prepare(`
        WITH RECURSIVE ordered AS (
            SELECT id, title, printf('%08d-%010d', COALESCE(position, 0), id) AS path, '' AS trail
            FROM nodes WHERE project_id = ? AND parent_id IS NULL
            UNION ALL
            SELECT c.id, c.title,
                   o.path || '/' || printf('%08d-%010d', COALESCE(c.position, 0), c.id),
                   CASE WHEN o.trail = '' THEN o.title ELSE o.trail || ' › ' || o.title END
            FROM nodes c JOIN ordered o ON c.parent_id = o.id
        )
        SELECT n.id, n.title, n.status, n.completed_at AS completedAt, o.trail
        FROM ordered o JOIN nodes n ON n.id = o.id
        WHERE ${WORK_LEAF}
        ORDER BY o.path
    `).all(projectId);
}

/** When the learner last did anything on a topic that is not finished. */
function lastStudiedAt(nodeId) {
    const row = db.prepare(`
        SELECT MAX(at) AS at FROM (
            SELECT MAX(consumed_at) AS at FROM feed_items WHERE node_id = ? AND status = 'consumed'
            UNION ALL
            SELECT MAX(strftime('%Y-%m-%dT%H:%M:%SZ', created_at)) FROM mastery_evidence WHERE node_id = ?
        )
    `).get(nodeId, nodeId);
    return row?.at || null;
}

/**
 * The previous topic's text: its served lessons, else its Overview + Material.
 * A lesson grounded in the course's documents is stored with a `Sources:` line
 * of document titles (lessonSources.js); that line is where the lesson came
 * from, not what it taught, and a writer shown it would cite a source it was
 * never given. `teachingText` takes it off, as it does for the question writer.
 */
function previousTopicText(nodeId) {
    const shown = db.prepare(`
        SELECT content FROM feed_items
        WHERE node_id = ? AND kind = 'lesson' AND status = 'consumed'
        ORDER BY seq
    `).all(nodeId).map(r => teachingText(r.content));
    const lessons = shownLessonText(shown);
    if (lessons) return { source: 'shown', text: lessons };

    const node = db.prepare('SELECT description FROM nodes WHERE id = ?').get(nodeId);
    const material = db.prepare(`
        SELECT title, description FROM nodes
        WHERE parent_id = ? AND is_note = 1 ORDER BY position, id
    `).all(nodeId);
    const parts = [];
    if (node?.description?.trim()) parts.push(node.description.trim());
    for (const m of material) {
        const body = String(m.description || '').trim();
        if (body) parts.push(`${m.title}\n${body}`);
    }
    const text = shownLessonText(parts);
    return text ? { source: 'overview', text } : null;
}

/**
 * The raw neighbourhood of one topic — what `formatCourseContext` renders.
 * Null when the node is not a work leaf of its course.
 */
export function courseNeighbourhood(nodeId, { before = NEIGHBOURS_BEFORE, after = NEIGHBOURS_AFTER } = {}) {
    const node = db.prepare('SELECT project_id FROM nodes WHERE id = ?').get(nodeId);
    if (!node) return null;
    const leaves = courseLeaves(node.project_id);
    const idx = leaves.findIndex(l => l.id === nodeId);
    if (idx === -1) return null;

    const withStanding = (l) => ({
        id: l.id, title: l.title, trail: l.trail, status: l.status,
        completedAt: l.completedAt,
        lastStudiedAt: l.status === 'completed' || l.status === 'skipped' ? null : lastStudiedAt(l.id),
    });
    const beforeRows = leaves.slice(Math.max(0, idx - before), idx).map(withStanding);
    const afterRows = leaves.slice(idx + 1, idx + 1 + after).map(withStanding);

    const prevLeaf = beforeRows[beforeRows.length - 1] || null;
    let previous = null;
    if (prevLeaf) {
        const text = previousTopicText(prevLeaf.id);
        if (text) previous = { ...prevLeaf, ...text };
    }
    return {
        current: { id: leaves[idx].id, title: leaves[idx].title, trail: leaves[idx].trail },
        before: beforeRows,
        after: afterRows,
        previous,
        isFirst: idx === 0,
        isLast: idx === leaves.length - 1,
    };
}

/**
 * The block for the lesson writer, or '' — never throws: context is an
 * enrichment, and a lesson must not fail because its neighbours could not be
 * read.
 */
export function courseContextForNode(nodeId, { now = Date.now() } = {}) {
    try {
        return formatCourseContext(courseNeighbourhood(nodeId), { now });
    } catch {
        return '';
    }
}
