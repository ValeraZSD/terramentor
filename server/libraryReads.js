/**
 * What a chat turn may READ of the learner's own library, whole and in order —
 * for the lookup tools in server/aiTools.js.
 *
 * Retrieval was the only way in, and retrieval is the wrong instrument for two
 * questions learners actually ask. It answers "what in my vault is about X"
 * with the three best-matching PASSAGES, which is right for a question about a
 * concept and useless for "what files do we have" (measured 2026-09-28 on the
 * real library: project 113 holds 40 documents, the assistant saw passages from
 * one and told the learner "the only actual file I have access to right now is
 * one") and for "read me question 2 of exam 9" (it had no way to open a
 * document at all, so it said so). So there are two more ways in:
 *
 *   - a LISTING — every document in a project, or in the whole vault, with its
 *     id, type, size and pages. Complete, never ranked; when it has to be cut
 *     it SAYS it was cut and how to see the rest.
 *   - a READ — one document (or one topic's own text) in order, a bounded
 *     window at a time, each window saying exactly how to ask for the next.
 *     A PDF is read by its pages, because the extracted text carries the page
 *     breaks ("-- 3 of 11 --") and a page is what the learner will cite back.
 *
 * Everything is bounded twice: per call (`READ_CHARS_PER_CALL`) and per turn
 * (`READ_CHARS_PER_TURN`, shared by every read in the turn), so a 300-page
 * textbook can be read over several calls and turns but can never push the
 * rest of the conversation out of a small local model's context.
 *
 * READ-ONLY, like every tool a turn holds. Nothing here writes.
 */
import db from './database.js';
import { resolveProject } from './projectState.js';

/** The most one read returns. A typical exam page is 1,000–1,300 characters. */
export const READ_CHARS_PER_CALL = 6000;
/** The most all the reads of one turn may return together. */
export const READ_CHARS_PER_TURN = 30000;
/** The most documents one listing names; the rest are counted per project. */
export const LIST_MAX_DOCUMENTS = 60;
/** Below this many characters of real text per page, a PDF is scanned images. */
const SCANNED_CHARS_PER_PAGE = 40;

const fmt = (n) => Number(n || 0).toLocaleString('en-US');

/* ── the argument a model writes ─────────────────────────────────────────── */

/**
 * `read_document` / `read_topic` take one string in both protocols (a text
 * line and a native call's `document` field): an id or a title, optionally
 * followed by what to read. Forgiving about the words ("28 page 5", "docId 28,
 * pages 5-8", "28 from 6000"), merciless about the result: no id and no title
 * is nothing.
 *
 * A character offset only means something beside an id — "Notes from 2023" is
 * a title, not an offset into one.
 *
 * @returns {{id: number|null, title: string|null, pageFrom: number|null, pageTo: number|null, from: number|null}}
 */
export function parseReadArg(raw) {
    const original = String(raw ?? '').trim().replace(/^["'“”`]+|["'“”`]+$/g, '').trim();
    const out = { id: null, title: null, pageFrom: null, pageTo: null, from: null };
    if (!original) return out;
    let s = original;
    let m = s.match(/[\s,;·(]*\b(?:pages?|pp?\.)\s*(\d+)(?:\s*(?:-|–|—|to|through)\s*(\d+))?\)?\s*\.?$/i);
    if (m) {
        out.pageFrom = Number(m[1]);
        out.pageTo = m[2] ? Number(m[2]) : null;
        s = s.slice(0, m.index);
    } else {
        m = s.match(/[\s,;·(]*\b(?:from|at|offset|starting at|start at|continue at)\s*(?:char(?:acter)?s?\s*)?(\d+)\)?\s*\.?$/i);
        if (m) { out.from = Number(m[1]); s = s.slice(0, m.index); }
    }
    s = s.replace(/[\s,;:·.]+$/, '').trim();
    // `3:41` is how the assistant's own markers spell a topic; the node is
    // the second half.
    const pair = s.match(/^(\d+)\s*:\s*(\d+)$/);
    const idOnly = s.match(/^(?:doc(?:ument)?\s*(?:id)?|node\s*(?:id)?|topic\s*(?:id)?|id)?\s*[:#]?\s*(\d+)$/i);
    if (pair) out.id = Number(pair[2]);
    else if (idOnly) out.id = Number(idOnly[1]);
    else if (s) {
        out.title = s;
        if (out.from != null) { out.title = original; out.from = null; }
    }
    if (out.pageTo != null && out.pageFrom != null && out.pageTo < out.pageFrom) {
        [out.pageFrom, out.pageTo] = [out.pageTo, out.pageFrom];
    }
    return out;
}

/* ── a PDF's pages ───────────────────────────────────────────────────────── */

/**
 * The page breaks the PDF import writes into a document's text: each page's
 * text is followed by a line `-- N of M --`. Returns one entry per page with
 * its span in the ORIGINAL string, or null when the text has no breaks (a
 * Word file, a note, a PDF imported before the breaks were kept).
 *
 * @returns {{n: number, start: number, end: number, text: string}[] | null}
 */
export function splitPages(content) {
    const text = String(content ?? '');
    const re = /(^|\n)[ \t]*-- (\d+) of (\d+) --[ \t]*(?=\n|$)/g;
    const pages = [];
    let start = 0;
    let m;
    while ((m = re.exec(text))) {
        const markerStart = m.index + m[1].length;
        pages.push({ n: pages.length + 1, start, end: markerStart, text: text.slice(start, markerStart).trim() });
        start = m.index + m[0].length;
    }
    if (!pages.length) return null;
    const rest = text.slice(start);
    if (rest.trim()) {
        const last = pages[pages.length - 1];
        last.end = text.length;
        last.text = `${last.text}\n\n${rest.trim()}`.trim();
    }
    return pages;
}

/** Real characters on the pages, markers and whitespace excluded. */
const realChars = (pages) => pages.reduce((a, p) => a + p.text.replace(/\s+/g, '').length, 0);

/** A PDF whose pages carry (almost) no text: scanned images. */
export function isScanned(pages) {
    return !!pages?.length && realChars(pages) < SCANNED_CHARS_PER_PAGE * pages.length;
}

/* ── finding one ─────────────────────────────────────────────────────────── */

const DOC_COLS = `
    SELECT d.id, d.title, d.original_filename, d.file_type, d.page_count, d.status, d.error,
           d.project_id, d.node_id, length(d.content) AS chars,
           p.name AS project_name, n.title AS node_title
    FROM documents d
    LEFT JOIN projects p ON p.id = d.project_id
    LEFT JOIN nodes n ON n.id = d.node_id`;

const inScope = (doc, scope) => !scope?.projectId || doc.project_id === scope.projectId;

/**
 * The document a reference names: an id, or a title (exact, then contained,
 * then the one sharing the most whole words). `scope.projectId` limits it to
 * one project — the tutor's, which reads only its own course's documents.
 */
export function findDocument(ref, scope = null) {
    if (ref?.id != null) {
        const doc = db.prepare(`${DOC_COLS} WHERE d.id = ?`).get(ref.id);
        return doc && inScope(doc, scope) ? doc : null;
    }
    const title = String(ref?.title || '').trim();
    if (!title) return null;
    const where = scope?.projectId ? ' AND d.project_id = ?' : '';
    const args = scope?.projectId ? [scope.projectId] : [];
    const exact = db.prepare(`${DOC_COLS} WHERE (lower(d.title) = lower(?) OR lower(d.original_filename) = lower(?))${where} ORDER BY d.id LIMIT 1`)
        .get(title, title, ...args);
    if (exact) return exact;
    const like = db.prepare(`${DOC_COLS} WHERE lower(d.title) LIKE '%' || lower(?) || '%'${where} ORDER BY length(d.title), d.id LIMIT 1`)
        .get(title, ...args);
    if (like) return like;
    const words = (s) => new Set(String(s).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 1));
    const asked = words(title);
    let best = null, bestScore = 0;
    for (const d of db.prepare(`${DOC_COLS} WHERE 1 = 1${where}`).all(...args)) {
        const score = [...words(d.title)].filter(w => asked.has(w)).length;
        if (score > bestScore) { best = d; bestScore = score; }
    }
    // One shared word is a coincidence ("exam"), not a match.
    return bestScore >= 2 || (bestScore === 1 && asked.size === 1) ? best : null;
}

/* ── the listing ─────────────────────────────────────────────────────────── */

const typeLabel = (t) => {
    const s = String(t || '').toLowerCase();
    return s ? (s.length <= 4 ? s.toUpperCase() : s) : 'text';
};

/** One document as one line the model can act on. */
function documentLine(d, pagesOf) {
    const parts = [`docId ${d.id}`, `"${d.title || d.original_filename || 'Untitled'}"`];
    const pages = pagesOf(d);
    parts.push(`${typeLabel(d.file_type)}${d.page_count ? `, ${d.page_count} page${d.page_count === 1 ? '' : 's'}` : ''}`);
    if (d.status === 'failed') parts.push(`import FAILED${d.error ? ` (${String(d.error).slice(0, 80)})` : ''} — no text`);
    else if (pages && isScanned(pages)) parts.push('scanned pages, no extractable text');
    else parts.push(`${fmt(d.chars)} characters of text`);
    if (d.node_id && d.node_title) parts.push(`on topic "${d.node_title}" (nodeId ${d.node_id})`);
    return `- ${parts.join(' · ')}`;
}

/**
 * Every document in a project, or in the whole vault — the answer to "what
 * files do we have". Complete up to LIST_MAX_DOCUMENTS; past that it says it
 * is capped and counts the rest per project, so "I only see these" is never a
 * sentence a cut list can produce.
 *
 * @param {string} arg `all`, a project id or a project name
 * @param {{projectId?: number}|null} scope the tutor's own project, which it may not leave
 * @returns {{context: string, count: number, label: string, summary: string}}
 */
export function listDocuments(arg, scope = null) {
    const wanted = String(arg ?? '').trim();
    let project = null;
    if (scope?.projectId) {
        project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(scope.projectId) || null;
    } else if (wanted && !/^(all|everything|every|vault|the vault|all projects|\*)$/i.test(wanted)) {
        project = resolveProject(wanted);
        if (!project) {
            return {
                context: `There is no project matching "${wanted}", so nothing was listed. Call list_documents with "all" for every document in the vault, or with a project id.`,
                count: 0, label: wanted, summary: 'no such project',
            };
        }
    }

    const rows = project
        ? db.prepare(`${DOC_COLS} WHERE d.project_id = ? ORDER BY d.id`).all(project.id)
        : db.prepare(`${DOC_COLS} ORDER BY d.project_id IS NULL, d.project_id, d.id`).all();
    const label = project ? project.name : 'all projects';
    // Pages are read only for PDFs, and only to tell a scanned one apart: the
    // listing is the place a learner finds out a file has no text in it.
    const contentOf = db.prepare('SELECT content FROM documents WHERE id = ?');
    const pagesOf = (d) => (String(d.file_type).toLowerCase() === 'pdf' ? splitPages(contentOf.get(d.id)?.content) : null);

    if (!rows.length) {
        const elsewhere = project
            ? db.prepare(`SELECT p.id, p.name, COUNT(*) AS n FROM documents d JOIN projects p ON p.id = d.project_id GROUP BY p.id ORDER BY n DESC LIMIT 8`).all()
            : [];
        return {
            context: project
                ? `Project "${project.name}" (projectId ${project.id}) has NO documents in its vault — this is a complete answer, not a gap in what you can see.${elsewhere.length ? `\nProjects that do hold documents: ${elsewhere.map(e => `"${e.name}" (projectId ${e.id}, ${e.n})`).join(', ')}.` : ''}`
                : 'The vault holds NO documents at all — this is a complete answer.',
            count: 0, label, summary: 'no documents',
        };
    }

    const shown = rows.slice(0, LIST_MAX_DOCUMENTS);
    const capped = rows.length > shown.length;
    const where = project ? `in project "${project.name}" (projectId ${project.id})` : 'in the whole vault';
    const lines = [capped
        ? `The learner's documents ${where}: ${rows.length} in all. This listing is CAPPED — it shows the first ${shown.length} of ${rows.length}. Say so if you answer from it, and never call it the whole list.`
        : `The learner's documents ${where}: ${rows.length} in all. This is the COMPLETE list — not a search, not a sample.`];
    let lastProject;
    for (const d of shown) {
        if (!project && d.project_id !== lastProject) {
            lastProject = d.project_id;
            lines.push(d.project_id ? `Project "${d.project_name}" (projectId ${d.project_id}):` : 'Not in any project:');
        }
        lines.push(documentLine(d, pagesOf));
    }
    if (capped) {
        const counts = db.prepare(`SELECT d.project_id AS id, p.name, COUNT(*) AS n FROM documents d LEFT JOIN projects p ON p.id = d.project_id GROUP BY d.project_id ORDER BY n DESC`).all();
        lines.push(`Not listed: ${rows.length - shown.length} more. Documents per project: ${counts.map(c => (c.id ? `"${c.name}" (projectId ${c.id}): ${c.n}` : `no project: ${c.n}`)).join('; ')}. Call list_documents with one projectId to see all of that project's.`);
    }
    lines.push('To read one, call read_document with its docId; a long one is read a few pages per call, and each result says how to ask for the next part. A document marked as having no text cannot be read until it is recovered — say so rather than guessing its contents.');
    return {
        context: lines.join('\n'),
        count: rows.length,
        label,
        summary: `${rows.length} document${rows.length === 1 ? '' : 's'}${capped ? `, ${shown.length} listed` : ''}`,
    };
}

/* ── reading a window ────────────────────────────────────────────────────── */

/** Cut `text` to at most `max` characters, at a paragraph or line break when one is near. */
function cutAt(text, max) {
    if (text.length <= max) return text;
    const slice = text.slice(0, max);
    const para = slice.lastIndexOf('\n\n');
    if (para > max * 0.6) return slice.slice(0, para);
    const line = slice.lastIndexOf('\n');
    if (line > max * 0.6) return slice.slice(0, line);
    const space = slice.lastIndexOf(' ');
    return space > max * 0.6 ? slice.slice(0, space) : slice;
}

/**
 * A turn's reading allowance, shared by every read tool the turn holds.
 * Created once per turn by `chatTools()`.
 */
export function readBudget(total = READ_CHARS_PER_TURN) {
    return { total, used: 0 };
}

const budgetSpent = (budget) => ({
    context: `This turn has already read ${fmt(budget.used)} characters of the learner's library, the most one turn may. Answer from what you have read so far, say plainly which part you have not read yet, and tell the learner they can ask you to continue.`,
    count: 0,
    summary: 'reading budget spent',
});

/**
 * One window of a document: by pages for a PDF with page breaks, by characters
 * otherwise. The text comes back as a CITABLE item (it is the learner's own
 * document, exactly like a retrieved vault chunk), the directions as context.
 *
 * @returns {{items?: object[], context: string, count: number, label?: string, part?: object, summary: string}}
 */
export function readDocument(arg, { scope = null, budget = readBudget() } = {}) {
    const ref = parseReadArg(arg);
    if (ref.id == null && !ref.title) {
        return { context: `"${arg}" does not name a document. Call read_document with a docId from list_documents.`, count: 0, summary: 'nothing' };
    }
    const doc = findDocument(ref, scope);
    if (!doc) {
        return {
            context: `No document ${ref.id != null ? `with docId ${ref.id}` : `titled "${ref.title}"`}${scope?.projectId ? ' in this project' : ''}. Call list_documents to see the real ids — never guess one.`,
            count: 0, label: ref.title || (ref.id != null ? `docId ${ref.id}` : undefined), summary: 'no such document',
        };
    }
    const title = doc.title || doc.original_filename || `Document ${doc.id}`;
    const head = `"${title}" (docId ${doc.id}${doc.project_name ? `, project "${doc.project_name}"` : ''})`;
    if (doc.status === 'failed') {
        return { context: `${head} failed to import${doc.error ? ` (${String(doc.error).slice(0, 160)})` : ''}; there is no text to read. Say so.`, count: 0, label: title, summary: 'no text' };
    }
    const room = Math.min(READ_CHARS_PER_CALL, budget.total - budget.used);
    if (room < 500) return { ...budgetSpent(budget), label: title };

    const content = String(db.prepare('SELECT content FROM documents WHERE id = ?').get(doc.id)?.content ?? '');
    const pages = splitPages(content);
    if (pages && isScanned(pages)) {
        return {
            context: `${head} has ${pages.length} page${pages.length === 1 ? '' : 's'}, and none of them carries text — it was scanned as pictures, so nothing in it can be read until it is recovered (the vault offers recovery with a vision model). Say exactly that; do not describe what it probably contains.`,
            count: 0, label: title, summary: 'scanned, no text',
        };
    }
    if (!content.trim()) {
        return { context: `${head} is empty — there is no text in it. Say so.`, count: 0, label: title, summary: 'no text' };
    }

    // By pages, unless a character offset was asked for or there are no pages.
    if (pages && ref.from == null) {
        const total = pages.length;
        const first = Math.min(Math.max(1, ref.pageFrom ?? 1), total);
        // "28" reads from the start as far as a window goes; "28 page 5" is
        // page 5 and nothing else — a model that names one page is about to
        // cite it, and a source titled "pages 5–9" would blur which one.
        const lastWanted = Math.min(Math.max(first, ref.pageTo ?? (ref.pageFrom != null ? first : total)), total);
        if (ref.pageFrom != null && ref.pageFrom > total) {
            return { context: `${head} has only ${total} pages; page ${ref.pageFrom} does not exist. It ends at page ${total}.`, count: 0, label: title, summary: 'past the end' };
        }
        const chunks = [];
        let used = 0;
        let lastRead = first - 1;
        let cutOffset = null;
        for (let n = first; n <= lastWanted; n++) {
            const p = pages[n - 1];
            const block = `[Page ${n}]\n${p.text || '(no text on this page)'}`;
            if (used + block.length > room) {
                if (n === first) {
                    // One page larger than a whole window: read what fits and
                    // continue from a character offset inside it.
                    const cut = cutAt(block, room);
                    chunks.push(cut);
                    used += cut.length;
                    const raw = content.slice(p.start, p.end);
                    const lead = raw.length - raw.trimStart().length;
                    cutOffset = Math.min(p.end, p.start + lead + Math.max(0, cut.length - `[Page ${n}]\n`.length));
                    lastRead = n;
                }
                break;
            }
            chunks.push(block);
            used += block.length + 2;
            lastRead = n;
        }
        budget.used += used;
        const span = first === lastRead ? `page ${first}` : `pages ${first}–${lastRead}`;
        const part = { unit: 'page', from: first, to: lastRead, of: total };
        let next;
        const onward = lastRead + 1 === total ? `page ${total}` : `pages ${lastRead + 1}-${total}`;
        if (cutOffset != null) next = `Page ${lastRead} is longer than one read and was cut; to read on, call read_document with "${doc.id} from ${cutOffset}".`;
        else if (lastRead < lastWanted && (ref.pageFrom != null || ref.pageTo != null)) next =`Only part of what you asked for fit in one read; to read on, call read_document with "${doc.id} ${lastRead + 1 === lastWanted ? `page ${lastWanted}` : `pages ${lastRead + 1}-${lastWanted}`}".`;
        else if (lastRead < total) next = `The document continues after page ${lastRead}: to read on, call read_document with "${doc.id} ${onward}".`;
        else next = first === 1 ? 'That is the whole document.' : `That is the end of the document (it has ${total} pages).`;
        return {
            items: [{ title: `${title}, ${span}`, content: chunks.join('\n\n') }],
            context: `read_document returned ${span} of ${total} of ${head}, as a numbered source you may cite. ${next}`,
            count: 1, label: title, part, summary: `${span} of ${total}`,
        };
    }

    const total = content.length;
    const from = Math.min(Math.max(0, ref.from ?? 0), total);
    if (from >= total) {
        return { context: `${head} has ${fmt(total)} characters; offset ${fmt(from)} is past its end.`, count: 0, label: title, summary: 'past the end' };
    }
    const text = cutAt(content.slice(from), room);
    const to = from + text.length;
    budget.used += text.length;
    const part = { unit: 'char', from, to, of: total };
    const next = to < total
        ? `It continues: to read on, call read_document with "${doc.id} from ${to}".`
        : (from === 0 ? 'That is the whole document.' : 'That is the end of the document.');
    return {
        items: [{ title: from === 0 && to >= total ? title : `${title}, characters ${fmt(from)}–${fmt(to)} of ${fmt(total)}`, content: text }],
        context: `read_document returned characters ${fmt(from)}–${fmt(to)} of ${fmt(total)} of ${head}, as a numbered source you may cite. ${next}`,
        count: 1, label: title, part, summary: `characters ${from}–${to} of ${total}`,
    };
}

/* ── a topic's own text ──────────────────────────────────────────────────── */

/**
 * The topic a reference names: a nodeId, `projectId:nodeId` (the markers'
 * spelling), or a title (exact, then the shortest containing it).
 */
export function findTopic(ref) {
    const cols = `SELECT n.id, n.title, n.status, n.description, n.notes, n.is_note, n.project_id, n.parent_id,
                         p.name AS project_name
                  FROM nodes n JOIN projects p ON p.id = n.project_id`;
    if (ref?.id != null) return db.prepare(`${cols} WHERE n.id = ?`).get(ref.id) || null;
    const title = String(ref?.title || '').trim();
    if (!title) return null;
    return db.prepare(`${cols} WHERE lower(n.title) = lower(?) ORDER BY n.is_note, n.id LIMIT 1`).get(title)
        || db.prepare(`${cols} WHERE lower(n.title) LIKE '%' || lower(?) || '%' ORDER BY n.is_note, length(n.title), n.id LIMIT 1`).get(title)
        || null;
}

/**
 * The whole of a topic as the app holds it: its Overview, its Material (the
 * note children), the learner's private notes, and — for a section — the
 * topics under it with their ids. The notes ride along on the precedent the
 * node tutor set (`buildNodeContext` has always carried them into its
 * context): the export contract keeps them off anything SHARED, and the model
 * the learner configured is not a share. They are labelled as theirs, so they
 * are never presented back as a source.
 *
 * Context, never a citation: this is the course's own filing, and the learner
 * is the authority on it (the same rule as the library search).
 */
export function readTopic(arg, { budget = readBudget() } = {}) {
    const ref = parseReadArg(arg);
    if (ref.id == null && !ref.title) {
        return { context: `"${arg}" does not name a topic. Call read_topic with a nodeId from project_state or find_in_library.`, count: 0, summary: 'nothing' };
    }
    const node = findTopic(ref);
    if (!node) {
        return { context: `No topic ${ref.id != null ? `with nodeId ${ref.id}` : `titled "${ref.title}"`}. Use project_state or find_in_library for the real ids — never guess one.`, count: 0, label: ref.title || undefined, summary: 'no such topic' };
    }
    const room = Math.min(READ_CHARS_PER_CALL, budget.total - budget.used);
    if (room < 500) return { ...budgetSpent(budget), label: node.title };

    const parent = node.parent_id ? db.prepare('SELECT title FROM nodes WHERE id = ?').get(node.parent_id) : null;
    const material = db.prepare('SELECT title, description FROM nodes WHERE parent_id = ? AND is_note = 1 ORDER BY position, id').all(node.id)
        .filter(n => String(n.description || '').trim());
    const children = db.prepare('SELECT id, title, status FROM nodes WHERE parent_id = ? AND is_note = 0 ORDER BY position, id').all(node.id);
    const sections = [];
    if (String(node.description || '').trim()) sections.push(`OVERVIEW:\n${String(node.description).trim()}`);
    for (const m of material) sections.push(`MATERIAL "${m.title}":\n${String(m.description).trim()}`);
    if (String(node.notes || '').trim()) {
        sections.push(`THE LEARNER'S OWN PRIVATE NOTES on this topic (theirs — use them to understand what they think; never present them as a source):\n${String(node.notes).trim()}`);
    }
    if (children.length) {
        sections.push(`TOPICS UNDER IT (nodeId · title · status):\n${children.map(c => `- ${c.id} · ${c.title} · ${c.status || 'not_started'}`).join('\n')}`);
    }
    const header = `Topic "${node.title}" (nodeId ${node.id}, projectId ${node.project_id}) in project "${node.project_name}"${parent ? `, under "${parent.title}"` : ''} — status ${node.status || 'not_started'}${node.is_note ? ' (this is a piece of Material, not a topic)' : ''}.`;
    const body = sections.join('\n\n');
    if (!body) {
        return { context: `${header}\nIt has no Overview, no Material and no notes yet — nothing is written on it. Say so.`, count: 1, label: node.title, summary: 'empty' };
    }
    const from = Math.min(Math.max(0, ref.from ?? 0), body.length);
    const text = cutAt(body.slice(from), room);
    const to = from + text.length;
    budget.used += text.length;
    const next = to < body.length
        ? `\n(Cut at character ${fmt(to)} of ${fmt(body.length)}: to read on, call read_topic with "${node.id} from ${to}".)`
        : '';
    return {
        context: `${header}\n\n${text}${next}`,
        count: 1, label: node.title,
        ...(from > 0 || to < body.length ? { part: { unit: 'char', from, to, of: body.length } } : {}),
        summary: to < body.length ? `characters ${from}–${to} of ${body.length}` : 'read',
    };
}

/** How many documents a project's vault holds — decides whether its tutor gets the document tools. */
export function projectDocumentCount(projectId) {
    if (!Number.isInteger(Number(projectId))) return 0;
    return db.prepare('SELECT COUNT(*) AS n FROM documents WHERE project_id = ?').get(Number(projectId))?.n || 0;
}
