// Where the learner is standing, for the assistant: the screen, the course, and
// when a topic is open, everything the old per-topic tutor knew about it.
//
// The assistant is the app's one chat, so a question about the topic on screen
// gets the topic's whole context — the Overview, the learner's notes, the
// subtopics, what they have finished, what comes next — from whichever screen
// it is asked on, with no switch: the page decides. A cut of the Overview is
// not enough to teach from.
import db from './database.js';
import { buildNodeContext } from './ai.js';

// Budgets for the parts that are not the topic's own context. It sits in front
// of the cross-project snapshot, so it has to stay a briefing, not a dump.
const PAGE_MATERIAL_CHARS = 1800;
const PAGE_LESSON_CHARS = 2500;
const PAGE_MISSES = 3;
const PAGE_MISS_CHARS = 220;

/**
 * The learner's own material under a topic: its `is_note` children, which is
 * where a curriculum's real depth lives (the feed teaches them as the lesson
 * body). Budgeted across however many there are, so one long reading can't eat
 * the whole allowance.
 */
function topicMaterial(nodeId) {
    const notes = db.prepare(`
        SELECT title, description FROM nodes
        WHERE parent_id = ? AND is_note = 1
        ORDER BY position ASC LIMIT 4
    `).all(nodeId).filter(n => String(n.description || '').trim());
    if (!notes.length) return '';
    const per = Math.max(300, Math.floor(PAGE_MATERIAL_CHARS / notes.length));
    return notes.map(n => `- ${n.title}: ${String(n.description).trim().slice(0, per)}`).join('\n');
}

/**
 * What the learner recently got WRONG on this topic — the single most useful
 * thing the assistant can know when asked "why don't I get this". Read from the
 * feed's own consumed questions (result = {correct, answer}), so it reflects
 * what actually happened, not what a model assumes happened.
 */
function recentMisses(nodeId) {
    let rows = [];
    try {
        rows = db.prepare(`
            SELECT content, result FROM feed_items
            WHERE node_id = ? AND kind = 'question' AND status = 'consumed' AND result IS NOT NULL
            ORDER BY consumed_at DESC LIMIT 12
        `).all(nodeId);
    } catch { return ''; }

    const out = [];
    for (const r of rows) {
        if (out.length >= PAGE_MISSES) break;
        let res = null;
        let q = null;
        try { res = JSON.parse(r.result); } catch { continue; }
        if (!res || res.correct !== false) continue;
        try { q = JSON.parse(r.content); } catch { continue; }
        const stem = String(q?.question || '').replace(/```[\s\S]*?```/g, '[diagram]').trim();
        if (!stem) continue;
        out.push(`- Asked: ${stem.slice(0, PAGE_MISS_CHARS)}`
            + (res.answer ? `\n  They answered: ${String(res.answer).slice(0, 120)}` : '')
            + (q?.answer ? `\n  Correct: ${String(q.answer).slice(0, 120)}` : ''));
    }
    return out.join('\n');
}

/**
 * Describe the screen the learner is on.
 *
 * Takes ids, returns prose — and every name in that prose is read out of the
 * database here. The client is trusted to say *where* it is, never *what* is
 * there, so no amount of client (or injected) text can put a fabricated topic
 * into the model's context as fact. `feedItemId` obeys the same rule: it names
 * a row, and the row's own text is what gets quoted.
 *
 * Returns { text, projectId, nodeId } — the ids scope the vault search, so a
 * question asked inside a topic searches that topic's and its course's
 * documents first instead of everything.
 */
export function buildPageContext(context) {
    const empty = { text: '', projectId: null, nodeId: null };
    if (!context || typeof context !== 'object') return empty;
    const view = typeof context.view === 'string' ? context.view : '';
    const nodeId = Number(context.nodeId);
    const projectId = Number(context.projectId);
    const feedItemId = Number(context.feedItemId);
    const lines = [];
    let scopeProjectId = Number.isInteger(projectId) ? projectId : null;
    let scopeNodeId = null;

    // On the feed there is no "selected node" — the card in front of the reader
    // is the context, and the client reports it by row id.
    let focusNodeId = Number.isInteger(nodeId) ? nodeId : null;
    let feedItem = null;
    if (!focusNodeId && Number.isInteger(feedItemId)) {
        feedItem = db.prepare('SELECT id, node_id, kind, content FROM feed_items WHERE id = ?').get(feedItemId);
        if (feedItem) focusNodeId = feedItem.node_id;
    }

    if (focusNodeId) {
        const node = db.prepare(`
            SELECT n.id, n.title, n.status, p.id AS pid, p.name AS pname
            FROM nodes n JOIN projects p ON p.id = n.project_id WHERE n.id = ?
        `).get(focusNodeId);
        if (node) {
            scopeProjectId = node.pid;
            scopeNodeId = node.id;
            lines.push(`Open topic: "${node.title}" (projectId ${node.pid}, nodeId ${node.id}) in project "${node.pname}" — status ${node.status}.`);
            // The whole of what the topic's teaching is written from: Overview,
            // the learner's notes, subtopics, resources, what they have already
            // finished in this course and what genuinely comes next.
            const known = buildNodeContext(node.id, { completedTopics: true, curriculumPosition: true, profile: false }).trim();
            if (known) lines.push(`What the app holds on this topic:\n${known}`);

            const material = topicMaterial(node.id);
            if (material) lines.push(`Material attached to this topic:\n${material}`);

            if (feedItem?.kind === 'lesson') {
                lines.push(`The card they are reading right now (quote and build on THIS, do not re-teach it from scratch):\n${String(feedItem.content).slice(0, PAGE_LESSON_CHARS)}`);
            } else if (feedItem?.kind === 'question') {
                let q = null;
                try { q = JSON.parse(feedItem.content); } catch { /* keep going without it */ }
                if (q?.question) lines.push(`The question on their screen: ${String(q.question).slice(0, 600)}`);
            }

            const misses = recentMisses(node.id);
            if (misses) lines.push(`Recently answered WRONG on this topic:\n${misses}`);
        }
    } else if (Number.isInteger(projectId)) {
        const project = db.prepare('SELECT id, name, summary FROM projects WHERE id = ?').get(projectId);
        if (project) {
            lines.push(`Open project: "${project.name}" (projectId ${project.id}).`);
            if (project.summary) lines.push(`Its summary: ${String(project.summary).slice(0, 400)}`);
        }
    }

    const SCREENS = {
        today: 'the learning feed (the home page)',
        projects: 'the projects grid',
        calendar: 'the global calendar',
        settings: 'the settings screen',
        workspace: 'a project workspace',
    };
    if (SCREENS[view]) lines.push(`Screen: ${SCREENS[view]}.`);
    return { text: lines.join('\n'), projectId: scopeProjectId, nodeId: scopeNodeId };
}
