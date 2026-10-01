/**
 * ONE project in depth, for the assistant's `project_state` tool.
 *
 * The assistant's snapshot (`buildTodayBriefingContext`) is a triage summary:
 * the six most urgent projects, three topic titles per list, counts for the
 * rest, and no mastery or test scores at all. That is the right shape for "what
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

/** Open topics listed by title; the rest are counted. Enough for a course
 *  section or two, short enough that a small model reads all of it. */
const OPEN_TOPICS_LISTED = 25;
const RECENT_TESTS = 5;
const CLOSED_TOPICS_LISTED = 10;
const SECTIONS_LISTED = 5;

/**
 * The project a query names: an id, an exact name, a name that contains it,
 * or the name sharing the most whole words with it. Archived projects are found too — a
 * learner asking about one is asking about it.
 */
export function resolveProject(query) {
    const q = String(query ?? '').trim().replace(/^projectId\s*/i, '');
    if (!q) return null;
    const cols = 'id, name, status, start_date, deadline, study_days';
    if (/^\d+$/.test(q)) return db.prepare(`SELECT ${cols} FROM projects WHERE id = ?`).get(Number(q)) || null;
    const exact = db.prepare(`SELECT ${cols} FROM projects WHERE lower(name) = lower(?)`).get(q);
    if (exact) return exact;
    const like = db.prepare(`SELECT ${cols} FROM projects WHERE lower(name) LIKE '%' || lower(?) || '%' ORDER BY length(name) LIMIT 1`).get(q);
    if (like) return like;
    // Then WHOLE words in common: "driving theory" finds "Dutch Driving
    // License". Not the library search, whose prefix matching answered
    // "astrophysics" with "Wave physics" — a confident read of the wrong course.
    const words = (s) => new Set(String(s).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 2));
    const asked = words(q);
    let best = null, bestScore = 0;
    for (const p of db.prepare(`SELECT ${cols} FROM projects`).all()) {
        const score = [...words(p.name)].filter(w => asked.has(w)).length;
        if (score > bestScore || (score === bestScore && score > 0 && p.name.length < best.name.length)) { best = p; bestScore = score; }
    }
    return best;
}

const pct = (x) => `${Math.round(Math.max(0, Math.min(1, Number(x) || 0)) * 100)}%`;

/** SQLite's CURRENT_TIMESTAMP and JS's ISO string, both to a UTC date. */
const dateOf = (s) => String(s || '').slice(0, 10);

/** The whole state as plain text for the model. Null when there is no such project. */
export function projectStateText(projectId) {
    const p = db.prepare('SELECT id, name, status, start_date, deadline, study_days FROM projects WHERE id = ?').get(projectId);
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
    if (status !== 'active') lines.push(`Not active: its cards do not come up in reviews and nothing in it is scheduled until the learner makes it active again.`);
    const progress = projectProgress(p.id);
    if (topics.length || !sections.length) lines.push(`Progress: ${pct(progress?.fraction)} (${closed.length} of ${topics.length} topics closed).`);
    if (p.start_date && p.deadline) {
        let pace = null;
        try { pace = calculatePace(p.id); } catch { /* an unreadable schedule is no pace, not a failure */ }
        if (pace?.hasSchedule) {
            lines.push(`Pace: ${pace.paceStatus}${pace.daysBehind > 0 ? `, ${pace.daysBehind} study days behind` : ''} (the plan expects ${pct(pace.expectedProgress)}, done ${pct(pace.actualProgress)}).`);
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
