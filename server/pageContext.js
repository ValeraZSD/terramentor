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
import { LEAF_STATUS } from './today.js';
import { projectColourName } from './projectFields.js';
import { canonicalRef, listReports, resolveTarget } from './itemReports.js';

// Budgets for the parts that are not the topic's own context. It sits in front
// of the cross-project snapshot, so it has to stay a briefing, not a dump.
const PAGE_MATERIAL_CHARS = 1800;
const PAGE_LESSON_CHARS = 2500;
const PAGE_MISSES = 3;
const PAGE_MISS_CHARS = 220;
/** Enough of a course's description to rewrite it from. */
const PAGE_DESCRIPTION_CHARS = 1200;

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
        // A reported question counts neither way, here too.
        if (!res || res.correct !== false || res.reported) continue;
        try { q = JSON.parse(r.content); } catch { continue; }
        const stem = String(q?.question || '').replace(/```[\s\S]*?```/g, '[diagram]').trim();
        if (!stem) continue;
        out.push(`- Asked: ${stem.slice(0, PAGE_MISS_CHARS)}`
            + (res.answer ? `\n  They answered: ${String(res.answer).slice(0, 120)}` : '')
            + (q?.answer ? `\n  Correct: ${String(q.answer).slice(0, 120)}` : ''));
    }
    return out.join('\n');
}

// A results screen lists a whole sitting (a mastery check asks up to 30), so
// every item it shows is heard about: the one on screen in full, the others
// shorter, all of them inside one budget.
const PAGE_ITEMS = 30;
const PAGE_ITEM_CHARS = 900;
const PAGE_ITEM_SHORT = 400;
const PAGE_ITEMS_BUDGET = 9000;
const PAGE_REPORTS = 6;

const clip = (s, n) => {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * Is the item's key on the learner's screen? Once the screen has said right
 * or wrong, or shows the key itself (a card flipped, a drill item's feedback:
 * `keyShown`). An answer alone is not enough: a quiz or mastery check sends
 * the learner's DRAFT as `answer` and grades it only at the end. Until then
 * the assistant is not handed it, or "which one is right?" in a mastery check
 * would be answered.
 */
const keyOnScreen = (shown) => !!shown && (typeof shown.correct === 'boolean' || shown.keyShown === true);

const WITHHELD = 'Answer key: not on their screen yet (they have not answered), so not given here';

/**
 * A sequence's items in a fixed order that is never the key. Sorting them is
 * not enough: numbered steps ("Step 1 …", "First …") sort into the key.
 */
function unkeyedOrder(items, seed) {
    const hash = (s) => {
        let x = 2166136261;
        for (const ch of s) x = Math.imul(x ^ ch.codePointAt(0), 16777619) >>> 0;
        return x;
    };
    const out = items.map((s, i) => ({ s, i, k: hash(`${seed}\u0000${s}`) })).sort((a, b) => a.k - b.k || a.i - b.i);
    if (out.length > 1 && out.every((o, i) => o.i === i)) out.push(out.shift());
    return out.map(o => o.s);
}

/**
 * One item as the server holds it, in a line the model can check a claim
 * against. The stem, the key and what the screen says of their answer are
 * always there; the options and the explanation take what room is left under
 * `max`. A results list makes every row short, and right or wrong is what the
 * learner asks about there.
 */
function itemLine(target, shown, max = PAGE_ITEM_CHARS) {
    const v = target.item || {};
    const key = keyOnScreen(shown);
    const short = max < PAGE_ITEM_CHARS;
    const lead = [], keyed = [], rest = [], after = [];
    if (target.kind === 'question' || target.kind === 'probe') {
        lead.push(`Question: ${clip(v.question, short ? 200 : 400)}`);
        if (Array.isArray(v.options) && v.options.length) rest.push(`Options: ${v.options.map((o, i) => `${String.fromCharCode(65 + i)}) ${clip(o, 80)}`).join(' | ')}`);
        // Stored in the right order, which is the key; shuffled on their screen.
        const items = Array.isArray(v.items) ? v.items.map(o => clip(o, 60)) : [];
        if (!key) {
            if (items.length) rest.push(`Items to put in order: ${unkeyedOrder(items, target.ref).join(' | ')}`);
            keyed.push(WITHHELD);
        } else {
            if (items.length) keyed.push(`Items in the right order: ${items.join(' → ')}`);
            if (v.correct_answer !== undefined) keyed.push(`Answer key: ${clip(typeof v.correct_answer === 'string' ? v.correct_answer : JSON.stringify(v.correct_answer), 200)}${v.unit ? ` ${v.unit}` : ''}${v.tolerance != null ? ` (±${v.tolerance})` : ''}`);
            if (v.explanation) after.push(`Explanation stored with it: ${clip(v.explanation, 300)}`);
        }
    } else if (target.kind === 'card') {
        lead.push(`Front: ${clip(v.front, 300)}`);
        keyed.push(key ? `Back: ${clip(v.back, 300)}` : 'Back: not turned over yet, so not given here');
    } else if (target.kind === 'drill') {
        lead.push(`Prompt: ${clip(v.prompt, 200)}`);
        keyed.push(key ? `Answer key: ${clip(v.answer, 200)}` : WITHHELD);
    } else if (target.kind === 'lesson') {
        rest.push(`Lesson text: ${clip(v.text, 600)}`);
    } else if (target.kind === 'paper') {
        // The reference solution never leaves the server before the learner has worked it.
        rest.push(`Exercise brief: ${clip(v.brief, 400)}`);
    }
    const said = [];
    if (shown) {
        if (typeof shown.answer === 'string' && shown.answer.trim()) said.push(`Their answer, as their screen reports it: ${clip(shown.answer, 160)}`);
        if (typeof shown.correct === 'boolean') said.push(`Marked ${shown.correct ? 'right' : 'wrong'} on their screen`);
    }
    const layout = [
        ...lead.map(s => [s, true]), ...rest.map(s => [s, false]), ...keyed.map(s => [s, true]),
        ...said.map(s => [s, true]), ...after.map(s => [s, false]),
    ];
    let room = max - layout.filter(([, keep]) => keep).reduce((n, [s]) => n + s.length + 3, 0);
    return layout.map(([s, keep]) => {
        if (keep) return s;
        const fit = room < 40 ? null : s.length + 3 <= room ? s : `${s.slice(0, room - 4)}…`;
        if (fit) room -= fit.length + 3;
        return fit;
    }).filter(Boolean).join('\n  ');
}

/**
 * The items on the learner's screen and the ones they answered earlier in this
 * sitting, newest first. The client names each by its ref and says what it
 * showed (their answer, right or wrong); the item's own text — stem, options,
 * key — is read here, so a claim that the key is wrong is checked against the
 * key the app really holds.
 */
function screenItems(raw) {
    if (!Array.isArray(raw)) return '';
    const out = [];
    const seen = new Set();
    // The client marks the item the learner is on. A feed's unanswered cards
    // all mount at once and are listed unmarked, so none is called "on
    // screen now" by being the last to mount; a caller that marks nothing
    // means its first item.
    const list = raw.slice(0, PAGE_ITEMS);
    const marked = list.some(it => typeof it?.current === 'boolean');
    const found = [];
    for (const it of list) {
        const ref = typeof it?.ref === 'string' ? canonicalRef(it.ref) : null;
        if (!ref || seen.has(ref)) continue;
        seen.add(ref);
        let target = null;
        try { target = resolveTarget(ref); } catch { target = null; }
        if (target) found.push({ it, target });
    }
    // One question about the reports standing on all of them, not one per item.
    let standing = new Map();
    try { standing = new Map(listReports({ refs: found.map(f => f.target.ref) }).map(r => [r.ref, r])); } catch { /* listed without */ }
    let named = false;
    let used = 0;
    for (const [i, { it, target }] of found.entries()) {
        const now = !named && (marked ? it.current === true : i === 0);
        if (now) named = true;
        const r = standing.get(target.ref);
        const line = `- [${target.ref}] ${target.kind}${now ? ' — on screen now' : ''}${r ? ` — already reported (report ${r.id}, ${r.reason})` : ''}\n  ${itemLine(target, it, now ? PAGE_ITEM_CHARS : PAGE_ITEM_SHORT)}`;
        if (out.length && used + line.length > PAGE_ITEMS_BUDGET) {
            out.push(`- and ${found.length - i} more on their screen, not listed here`);
            break;
        }
        out.push(line);
        used += line.length;
    }
    return out.join('\n');
}

/** Reports standing on the topic, so the assistant can say what is already reported, and undo one. */
function standingReports(nodeId) {
    let rows = [];
    try { rows = listReports({ nodeId, limit: PAGE_REPORTS }); } catch { return ''; }
    return rows.map(r => `- report ${r.id}: ${r.kind} [${r.ref}], ${r.reason}${r.note ? `, "${clip(r.note, 120)}"` : ''}${r.rewrite?.state ? `, new version ${r.rewrite.state}` : ''}`).join('\n');
}

/**
 * How the open course looks and stands, for an assistant asked to change it:
 * it proposes only the fields that change, so it has to know the others. The
 * colour is named when it is a palette colour, because that is the word the
 * assistant is given to write back.
 */
function projectLook(projectId) {
    const p = db.prepare('SELECT name, icon, color, description, status FROM projects WHERE id = ?').get(projectId);
    if (!p) return '';
    const colourName = projectColourName(p.color);
    const lines = [`Course "${p.name}" now: icon "${p.icon || 'folder'}", colour ${p.color}${colourName ? ` (${colourName})` : ''}, status ${p.status || 'active'}.`];
    const description = String(p.description || '').trim();
    lines.push(description ? `Its description: ${description.slice(0, PAGE_DESCRIPTION_CHARS)}` : 'It has no description.');
    return lines.join('\n');
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
            SELECT n.id, n.title, ${LEAF_STATUS} AS status, p.id AS pid, p.name AS pname
            FROM nodes n JOIN projects p ON p.id = n.project_id WHERE n.id = ?
        `).get(focusNodeId);
        if (node) {
            scopeProjectId = node.pid;
            scopeNodeId = node.id;
            lines.push(`Open topic: "${node.title}" (projectId ${node.pid}, nodeId ${node.id}) in project "${node.pname}" — status ${node.status}.`);
            const look = projectLook(node.pid);
            if (look) lines.push(look);
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

            const reports = standingReports(node.id);
            if (reports) lines.push(`Items the learner reported as wrong on this topic (they count neither way; undo one by its report number):\n${reports}`);
        }
    } else if (Number.isInteger(projectId)) {
        const project = db.prepare('SELECT id, name, summary FROM projects WHERE id = ?').get(projectId);
        if (project) {
            lines.push(`Open project: "${project.name}" (projectId ${project.id}).`);
            const look = projectLook(project.id);
            if (look) lines.push(look);
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

    const items = screenItems(context.items);
    if (items) lines.push(`Items on their screen and answered earlier in this sitting, newest first (the app's own copy of each; an item's key is given only once it is on their screen; refs in brackets):\n${items}`);
    return { text: lines.join('\n'), projectId: scopeProjectId, nodeId: scopeNodeId };
}
