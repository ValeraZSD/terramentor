/**
 * ONE project in depth, for the assistant's `project_state` tool.
 *
 * The assistant's snapshot (`buildTodayBriefingContext`) is a triage summary:
 * the six most urgent projects, three topic titles per list, the other active
 * projects by name and id only (on a turn holding this tool), and no mastery or test scores at all. That is the right shape for "what
 * should I do today" and the wrong one for anything about a single course —
 * "am I ready for the exam", "what should I cut", "which topics are weak" — and
 * the assistant said so itself when asked what it needed: every control it
 * could be given acts on numbers it cannot see.
 *
 * READ-ONLY, like every tool a turn holds. The ids it prints are the ones the
 * assistant's markers (`[[open:…]]`, `[[check:…]]`, a card's topic line) need,
 * so a proposal can point at a topic that is not in the snapshot.
 */
import db from './database.js';
import { calculatePace } from './scheduling.js';
import { deadlineInfo, LEAF_NODE, WORK_LEAF } from './today.js';
import { reviewDue } from './decks.js';
import { projectProgress } from './progress.js';
import { projectColourName } from './projectFields.js';

/** Open topics listed by title; the rest are counted. Enough for a course
 *  section or two, short enough that a small model reads all of it. */
const OPEN_TOPICS_LISTED = 25;
const RECENT_TESTS = 5;
const CLOSED_TOPICS_LISTED = 10;
const SECTIONS_LISTED = 5;

/** Candidates named when a query fits several projects equally. */
const AMBIGUOUS_LISTED = 8;
/** A candidate's name, and the query echoed back, are cut at this length. */
const NAME_CHARS = 120;

/**
 * The project a query names: an id, an exact name, a name that contains it,
 * or the name sharing the most whole words with it. Archived projects are found too — a
 * learner asking about one is asking about it.
 *
 * Where a step fits SEVERAL projects equally, none is picked: `project` is null
 * and `candidates` holds them, because the shortest-name tie-break read the
 * wrong one of two near-identical courses (two names differing only by "and"
 * against "&") with nothing to say it had chosen. The one exception is a tie
 * with exactly ONE active project in it — a restarted course beside its
 * archived predecessor — which that active one wins.
 *
 * Matching is done here rather than in SQL: SQLite's `lower()` and `LIKE` fold
 * ASCII only, so "математика" found "Математика" only by the word step.
 *
 * @returns {{project: object|null, candidates: object[]}}
 */
export function findProject(query) {
    const none = { project: null, candidates: [] };
    const q = String(query ?? '').trim().replace(/^projectId\s*/i, '');
    if (!q) return none;
    const cols = 'id, name, status, start_date, deadline, study_days';
    const decide = (rows) => {
        if (rows.length === 1) return { project: rows[0], candidates: [] };
        const active = rows.filter(p => (p.status || 'active') === 'active');
        if (active.length === 1) return { project: active[0], candidates: [] };
        // Active ones first, so a capped list keeps the ones most likely meant.
        return { project: null, candidates: [...active, ...rows.filter(p => !active.includes(p))] };
    };
    // An id first; a number that is no id may still be a name ("2026").
    if (/^\d+$/.test(q)) {
        const byId = db.prepare(`SELECT ${cols} FROM projects WHERE id = ?`).all(Number(q));
        if (byId.length) return decide(byId);
    }
    const all = db.prepare(`SELECT ${cols} FROM projects ORDER BY id`).all();
    const lq = q.toLowerCase();
    const exact = all.filter(p => String(p.name).toLowerCase() === lq);
    if (exact.length) return decide(exact);
    const containing = all.filter(p => String(p.name).toLowerCase().includes(lq));
    if (containing.length) return decide(containing);
    // Then WHOLE words in common: "driving theory" finds "Driving License
    // Prep". Not the library search, whose prefix matching would answer
    // "astrophysics" with "Wave physics" — a confident read of the wrong course.
    const words = (s) => new Set(String(s).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 2));
    const asked = words(q);
    let best = [], bestScore = 0;
    for (const p of all) {
        const score = [...words(p.name)].filter(w => asked.has(w)).length;
        if (score > bestScore) { best = [p]; bestScore = score; }
        else if (score === bestScore && score > 0) best.push(p);
    }
    return best.length ? decide(best) : none;
}

/** What a lookup says instead of picking one of several projects. */
export function ambiguousProjectText(query, candidates) {
    const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
    const named = candidates.slice(0, AMBIGUOUS_LISTED).map(p => `(projectId ${p.id}) ${cut(String(p.name), NAME_CHARS)}${p.status && p.status !== 'active' ? ` — ${p.status}` : ''}`);
    const more = candidates.length - named.length;
    return `"${cut(String(query), NAME_CHARS)}" fits ${candidates.length} projects equally, so none was read:\n${named.join('\n')}`
        + `${more > 0 ? `\n(and ${more} more — ask with more of the name to narrow it)` : ''}\n`
        + 'Ask again with the id of the one meant. If nothing in the conversation says which, ask the learner — never pick one.';
}

const pct = (x) => `${Math.round(Math.max(0, Math.min(1, Number(x) || 0)) * 100)}%`;

/** SQLite's CURRENT_TIMESTAMP and JS's ISO string, both to a UTC date. */
const dateOf = (s) => String(s || '').slice(0, 10);

/** The whole state as plain text for the model. Null when there is no such project. */
export function projectStateText(projectId) {
    const p = db.prepare('SELECT id, name, status, start_date, deadline, study_days, icon, color, description FROM projects WHERE id = ?').get(projectId);
    if (!p) return null;
    const today = new Date().toISOString().slice(0, 10);

    const topics = db.prepare(`
        SELECT n.id, n.title, n.status, n.scheduled_end, nm.mastery_score AS mastery
        FROM nodes n
        LEFT JOIN node_mastery nm ON nm.node_id = n.id
        WHERE n.project_id = ? AND ${WORK_LEAF}
    `).all(p.id);
    // Course order is the tree walked depth-first — `position` only orders
    // siblings, so sorting on it interleaves every section's first topic.
    const tree = db.prepare('SELECT id, parent_id, title, position FROM nodes WHERE project_id = ? AND is_note = 0 ORDER BY position, id').all(p.id);
    // A topic's section, named on its line: asked for "the whole Sound
    // section", the model read a flat list and said the project had none.
    const byNode = new Map(tree.map(n => [n.id, n]));
    const sectionOf = (t) => { const parent = byNode.get(byNode.get(t.id)?.parent_id); return parent ? ` (in ${parent.title})` : ''; };
    const kids = new Map();
    for (const n of tree) kids.set(n.parent_id, [...(kids.get(n.parent_id) || []), n.id]);
    const order = new Map();
    const walk = (parent) => { for (const id of kids.get(parent) || []) { order.set(id, order.size); walk(id); } };
    walk(null);
    topics.sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9));
    const open = topics.filter(t => t.status !== 'completed' && t.status !== 'skipped');

    const cards = db.prepare(`
        SELECT f.node_id,
               SUM(CASE WHEN ${reviewDue('f')} THEN 1 ELSE 0 END) AS due,
               SUM(CASE WHEN f.next_review IS NULL THEN 1 ELSE 0 END) AS unseen,
               COUNT(*) AS total
        FROM flashcards f JOIN nodes n ON n.id = f.node_id
        WHERE n.project_id = ?
        GROUP BY f.node_id
    `).all(p.id);
    const cardsByNode = new Map(cards.map(c => [c.node_id, c]));
    const sum = (k) => cards.reduce((a, c) => a + (c[k] || 0), 0);

    const tests = db.prepare(`
        SELECT me.evidence_type AS type, me.score, me.total, me.created_at, n.id AS nodeId, n.title
        FROM mastery_evidence me JOIN nodes n ON n.id = me.node_id
        WHERE n.project_id = ? AND me.evidence_type IN ('quiz', 'mastery_check', 'paper')
        ORDER BY me.created_at DESC, me.id DESC LIMIT ${RECENT_TESTS}
    `).all(p.id);

    const newPerDay = Number.parseInt(db.prepare('SELECT value FROM settings WHERE key = ?').get(`deck_new_per_day_${p.id}`)?.value ?? '', 10);

    // A deck's cards hang off its SECTIONS (the stages an import cut out of
    // card order), which are not topics — so a deck with no topics read as
    // "0 of 0 topics" and the assistant had nowhere to put a card.
    const sections = db.prepare(`
        SELECT n.id, n.title, (SELECT COUNT(*) FROM flashcards f WHERE f.node_id = n.id) AS cards
        FROM nodes n WHERE n.project_id = ? AND ${LEAF_NODE} AND NOT (${WORK_LEAF})
    `).all(p.id).sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9));
    const closed = topics.filter(t => t.status === 'completed' || t.status === 'skipped');

    const status = p.status || 'active';
    const lines = [`Project "${p.name}" (projectId ${p.id}) — ${status}.`];
    // What a proposed change to the course would replace (```project).
    const colourName = projectColourName(p.color);
    const description = String(p.description || '').trim();
    lines.push(`Looks: icon "${p.icon || 'folder'}", colour ${p.color}${colourName ? ` (${colourName})` : ''}. Description: ${description ? description.slice(0, 400) : '(none)'}`);
    if (status !== 'active') lines.push(`Not active: its cards do not come up in reviews and nothing in it is scheduled until the learner makes it active again.`);
    const progress = projectProgress(p.id);
    if (topics.length || !sections.length) lines.push(`Progress: ${pct(progress?.fraction)} (${closed.length} of ${topics.length} topics closed).`);
    if (p.start_date && p.deadline) {
        let pace = null;
        try { pace = calculatePace(p.id); } catch { /* an unreadable schedule is no pace, not a failure */ }
        if (pace?.hasSchedule) {
            // calculatePace's two progress figures are whole percents, not fractions.
            lines.push(`Pace: ${pace.paceStatus}${pace.studyDaysBehind > 0 ? `, ${pace.studyDaysBehind} study day${pace.studyDaysBehind === 1 ? '' : 's'} behind` : ''} (the plan expects ${pct(pace.expectedProgress / 100)}, done ${pct(pace.actualProgress / 100)}).`);
        }
    }
    const d = deadlineInfo(p, today);
    if (d) lines.push(d.passed
        ? `Deadline ${d.deadline} has PASSED.`
        : `Deadline ${d.deadline}: ${d.daysLeft} days away, ${d.studyDaysLeft} study days left including today.`);
    else lines.push('No deadline.');
    if (cards.length) {
        lines.push(`Cards: ${sum('total')} in all — ${sum('due')} due now, ${sum('unseen')} never seen${Number.isFinite(newPerDay) ? `; ${newPerDay} new cards a day (this project's own setting)` : ''}.`);
    }

    if (open.length) {
        lines.push('', 'Open topics in course order (nodeId · title · status · planned end · mastery):');
        for (const t of open.slice(0, OPEN_TOPICS_LISTED)) {
            const c = cardsByNode.get(t.id);
            const overdue = t.scheduled_end && t.scheduled_end < today ? ' OVERDUE' : '';
            const mastery = t.mastery != null ? `mastery ${pct(t.mastery)}` : 'no evidence yet';
            lines.push(`- ${t.id} · ${t.title}${sectionOf(t)} · ${t.status} · ${t.scheduled_end || 'unscheduled'}${overdue} · ${mastery}${c?.due ? ` · ${c.due} cards due` : ''}`);
        }
        if (open.length > OPEN_TOPICS_LISTED) lines.push(`(${open.length - OPEN_TOPICS_LISTED} more open topics not listed)`);
    } else if (topics.length) {
        lines.push('', 'Every topic is closed.');
    }
    if (closed.length) {
        // Closed topics still take cards, and a completed one can be retaken
        // (its check is then a retake: the topic stays completed).
        const recent = db.prepare(`
            SELECT id FROM nodes WHERE project_id = ? AND status IN ('completed', 'skipped')
            ORDER BY COALESCE(completed_at, updated_at) DESC, id DESC LIMIT ${CLOSED_TOPICS_LISTED}
        `).all(p.id).map(r => r.id);
        const byId = new Map(closed.map(t => [t.id, t]));
        lines.push('', 'Closed topics, most recent first (nodeId · title · status · mastery):');
        for (const id of recent) {
            const t = byId.get(id);
            if (t) lines.push(`- ${t.id} · ${t.title}${sectionOf(t)} · ${t.status} · ${t.mastery != null ? `mastery ${pct(t.mastery)}` : 'no evidence'}`);
        }
        if (closed.length > recent.length) lines.push(`(${closed.length - recent.length} more closed topics not listed)`);
    }
    if (sections.length) {
        lines.push('', `Card sections — not topics: they take cards and nothing else; a new card goes on the LAST one (nodeId · title · cards):`);
        for (const s of sections.slice(-SECTIONS_LISTED)) lines.push(`- ${s.id} · ${s.title} · ${s.cards} cards`);
        if (sections.length > SECTIONS_LISTED) lines.push(`(${sections.length - SECTIONS_LISTED} earlier sections not listed)`);
    }

    if (tests.length) {
        const name = { quiz: 'quiz', mastery_check: 'mastery check', paper: 'paper exercise' };
        lines.push('', 'Most recent tests:');
        for (const t of tests) lines.push(`- ${dateOf(t.created_at)} ${name[t.type] || t.type} on "${t.title}" (nodeId ${t.nodeId}): ${Math.round(t.score)}/${t.total}`);
    }
    lines.push('', 'Every id above is real. Use one only inside a marker ([[open:…]], [[check:…]], a card\'s topic line), never in a sentence the learner reads.');
    return lines.join('\n');
}

/** When nothing matched: the projects that DO exist, so the model can ask again by id. */
export function projectListText(limit = 20) {
    const rows = db.prepare(`
        SELECT id, name FROM projects WHERE COALESCE(status, 'active') = 'active'
        ORDER BY position ASC, created_at ASC LIMIT ?
    `).all(limit);
    return rows.map(r => `(projectId ${r.id}) ${r.name}`).join('\n');
}
