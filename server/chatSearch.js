// The assistant's conversation list, and searching it by what was said.
//
// `chat_messages_fts` (database.js) holds each message's WORDS as the learner
// reads them, not the stored text: the app's markers (`[[src:2]]`,
// `[[open:3:41]]`) and the specs of drawn blocks (a chart's JSON, a sketch's
// code) are left out, a proposed card is its two sides. That reading is
// JavaScript, so no trigger can compute it: the triggers only queue a written
// message in `chat_search_stale` (and take an edited or deleted message's old
// words out at once), and every search first indexes what is queued, at most
// SEARCH_INDEX_MAX messages, so a search never stalls the server. The first
// start of this build on an older library queues every message; a background
// pass indexes them in small batches, and a search meanwhile finds what is
// indexed so far.
//
// One row per conversation, ranked: a conversation whose title holds every
// word first (a message of files alone is titled by its file and has no other
// words), then by the best-ranked message (FTS5 bm25). A row carries the
// conversation's list fields and, when a message matched, which one, with a
// snippet and where the words are in it, so the drawer can open the
// conversation at that message.
//
// Keyword search, no meaning: "electricity" does not find "current". Case and
// accents fold (unicode61, remove_diacritics 2), every word is matched by its
// start (a one-letter word only as itself), and every word must stand in ONE
// message, or all in the title: a search finds the place something was said.
//
// Without the index (a SQLite built without FTS5) a search still matches
// titles; the reason goes to the server's log, never to the learner.

import db from './database.js';

/** At most this many conversations answer one search. */
export const CHAT_SEARCH_LIMIT = 50;
/** A query is read up to this many characters, and this many words of it. */
const QUERY_MAX = 200;
const TERMS_MAX = 12;
/** Messages indexed before one search, and per step of the background pass. */
const SEARCH_INDEX_MAX = 2000;
const INDEX_BATCH = 500;
/** A snippet: this many words, starting this many before the first match, at most this long. */
const SNIPPET_WORDS = 18;
const SNIPPET_LEAD = 5;
const SNIPPET_CHARS = 220;

// The blocks a message's Markdown DRAWS instead of showing as code: the visual
// languages (src/components/visuals/registry.ts ALIASES) and the drill
// (src/components/drills/parseDrill.ts DRILL_FENCE_LANGS). The learner sees a
// chart, a molecule or a game, never its spec, so the spec's words are not
// words of the answer. `math` is drawn too but is kept: its symbols are what
// the learner reads. tools/chat-search-gates.mjs holds this list to those two.
export const DRAWN_FENCES = new Set([
    'mermaid', 'vega', 'vega-lite', 'vegalite', 'chart', 'plot', 'graph', 'function-plot', 'smiles', 'molecule',
    'animation', 'animate', 'anim', 'smil', 'svg-anim', 'svg-animation',
    'p5', 'p5js', 'p5-js', 'sketch', 'simulation', 'widget', 'interactive', 'applet',
    'drill', 'practice', 'quiz-drill', 'flashdrill',
]);
const MATH_FENCES = new Set(['math', 'latex', 'katex', 'tex']);
// The app's prepared blocks (src/utils/assistantWrites.ts BLOCK_RE): lines of
// `field: value`, shown as a preview of their values.
const WRITE_FENCES = new Set(['card', 'capture', 'report', 'project', 'topic', 'link', 'course', 'short', 'save', 'wrong']);
// Fields of a prepared block that hold ids or settings, never words.
const MACHINE_FIELDS = new Set(['topic', 'ref', 'id', 'kind', 'reason', 'undo', 'rewrite', 'attachment', 'project', 'node', 'status']);

/** Every `[[…]]` marker the app turns into a control or a citation. In
 *  prose and prepared blocks only: inside code it is the code's text. */
const MARKER_RE = /\[\[[^\]\n]*\]\]/g;
/** A fenced block: closed by the same fence, or running to the end of the message. */
const FENCE_RE = /(^|\n)[ \t]*(`{3,}|~{3,})[ \t]*([^\s`~]*)[^\n]*(?:\n([\s\S]*?))?(?:\n[ \t]*\2[ \t]*(?=\n|$)|$)/g;
const FIELD_RE = /^[ \t]*([a-z_]+)[ \t]*:[ \t]?(.*)$/i;
const ID_VALUE_RE = /^[\s\d:,#-]*$/;

/** TeX commands out of math (`\frac`, `\lambda`), its symbols kept. */
const texWords = (math) => math.replace(/\\[a-zA-Z]+/g, ' ');

/** Markdown syntax out of prose, its words kept; TeX only inside `$…$`, so a
 *  path like `notes\physics\waves.md` keeps its words. */
function proseWords(text) {
    return text
        .replace(MARKER_RE, ' ')
        .replace(/(\$\$?)([^$]+?)\1/g, (_, d, math) => ` ${texWords(math)} `)
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, ' $1 ')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
        .replace(/^[ \t]*>[ \t]?/gm, '')
        .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, '')
        .replace(/^[ \t|:-]+$/gm, '')
        .replace(/[*`|$]+|~~|__/g, ' ');
}

/** A prepared block as its values, its field names and ids left out. */
function writeBlockWords(inner) {
    return inner.replace(MARKER_RE, ' ').split('\n').map(line => {
        const m = line.match(FIELD_RE);
        if (!m) return line;
        if (MACHINE_FIELDS.has(m[1].toLowerCase()) || ID_VALUE_RE.test(m[2])) return '';
        return m[2];
    }).join('\n');
}

/**
 * A stored message as the words a learner reads in it: what the search index
 * holds and what a snippet is cut from. Whitespace is one space.
 */
export function searchableText(content) {
    const text = String(content ?? '').normalize('NFC').replace(/\r\n?/g, '\n');
    const parts = [];
    let last = 0;
    for (const m of text.matchAll(FENCE_RE)) {
        parts.push(proseWords(text.slice(last, m.index)));
        const lang = m[3].toLowerCase();
        const inner = m[4] ?? '';
        if (WRITE_FENCES.has(lang)) parts.push(writeBlockWords(inner));
        else if (MATH_FENCES.has(lang)) parts.push(texWords(inner));
        else if (!DRAWN_FENCES.has(lang)) parts.push(inner);
        last = m.index + m[0].length;
    }
    parts.push(proseWords(text.slice(last)));
    return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * The words of a query, each quoted for FTS5 so nothing in it is read as
 * syntax (`AND`, `NEAR(`, `col:`, `^`, `*`); a word with no letter or digit is
 * dropped. The tokenizer splits a quoted word further where it would split
 * the text ("cross-section" is the phrase "cross section").
 */
export function queryTerms(q) {
    return String(q ?? '').normalize('NFC').slice(0, QUERY_MAX).split(/\s+/)
        .map(w => w.replace(/"/g, ''))
        .filter(w => /[\p{L}\p{N}]/u.test(w))
        .slice(0, TERMS_MAX);
}

/**
 * Text as the index holds it. The tokenizer folds Latin accents but not
 * Russian ё, which most Russian text writes as е, so ё is stored and asked
 * for as е. Same length, so nothing else moves.
 */
const indexForm = (s) => s.replace(/[ёЁ]/g, c => (c === 'ё' ? 'е' : 'Е'));

/** One character folded the way the index matches it: case, Latin accents, ё. */
function foldChar(c) {
    if (c === 'ё' || c === 'Ё') return 'е';
    const d = c.normalize('NFD');
    // Only a Latin letter loses its marks: Russian й is not и.
    return (/^\p{Script=Latin}/u.test(d) ? d.replace(/\p{M}+/gu, '') : c).toLowerCase();
}
const fold = (s) => Array.from(s, foldChar).join('');
const WORD_RE = /[\p{L}\p{N}\p{M}]+/gu;
const wordsOf = (s) => fold(s).match(WORD_RE) || [];

/** Does a title hold every word of the query (`parts`: each term's folded
 *  words), each as the start of one of its words, a one-letter word as itself? */
function titleMatches(title, parts) {
    const words = wordsOf(title);
    return parts.every(tp => tp.every(part => words.some(w => (part.length > 1 ? w.startsWith(part) : w === part))));
}

/** A term as FTS5 asks for it: quoted, and matched by its start unless every
 *  word in it is one letter ("C++" is the word "c"; "c*" is half the library). */
const ftsTerm = (t) => `"${indexForm(t)}"${wordsOf(t).every(w => w.length < 2) ? '' : '*'}`;

// Prepared on first use, not at load: a build of SQLite without FTS5 leaves no
// index table, and a statement prepared at load would take the whole chat
// route file down with it.
let stmts = null;
function statements() {
    if (stmts) return stmts;
    stmts = {
        stale: db.prepare('SELECT s.message_id AS id, m.role, m.content FROM chat_search_stale s LEFT JOIN chat_messages m ON m.id = s.message_id LIMIT ?'),
        drop: db.prepare('DELETE FROM chat_messages_fts WHERE rowid = ?'),
        add: db.prepare('INSERT INTO chat_messages_fts (rowid, body) VALUES (?, ?)'),
        unqueue: db.prepare('DELETE FROM chat_search_stale WHERE message_id = ?'),
        // The best message of each conversation, grouped in SQL so a long
        // conversation full of hits cannot crowd the others out. With one
        // min() the other columns come from the row that holds it (SQLite's
        // bare-column rule); a tie goes to the earlier message.
        hits: db.prepare(`
            WITH h AS MATERIALIZED (
                SELECT rowid AS id, rank AS r FROM chat_messages_fts WHERE chat_messages_fts MATCH ?
            )
            SELECT h.id AS messageId, m.conversation_id AS conversationId, m.role AS role, min(h.r) AS r
            FROM h JOIN chat_messages m ON m.id = h.id
            WHERE m.conversation_id IS NOT NULL
            GROUP BY m.conversation_id
            ORDER BY r, h.id
            LIMIT ?
        `),
        content: db.prepare('SELECT content FROM chat_messages WHERE id = ?'),
    };
    return stmts;
}

/** The words a message is indexed under. A message the reading chokes on is
 *  indexed as stored, so one odd row never blocks every search. */
function indexBody(row) {
    // A system row is the app's, not the conversation's. It is still given
    // a row, so the start-up sweep does not queue it again.
    if (row.role === 'system') return '';
    try {
        return indexForm(searchableText(row.content));
    } catch (e) {
        console.error(`[chat search] message ${row.id} indexed as stored:`, e.message);
        return indexForm(String(row.content));
    }
}

/** Index up to `limit` queued messages; how many were taken off the queue. */
const indexSome = db.transaction((limit) => {
    const s = statements();
    const rows = s.stale.all(limit);
    for (const row of rows) {
        s.drop.run(row.id);
        if (row.content != null) s.add.run(row.id, indexBody(row));
        s.unqueue.run(row.id);
    }
    return rows.length;
});

/** Before a search: what was written since the last one, bounded. */
function refreshIndex() {
    for (let done = 0; done < SEARCH_INDEX_MAX;) {
        const n = indexSome(INDEX_BATCH);
        done += n;
        if (n < INDEX_BATCH) break;
    }
}

// The background pass over an older library's messages: one batch, then a
// turn of the event loop for everything else, until the queue is empty. It
// stops on the first error (no index, or a test closed the database).
function drainIndex() {
    try {
        if (indexSome(INDEX_BATCH) === INDEX_BATCH) setTimeout(drainIndex, 0).unref?.();
    } catch (e) {
        console.error('[chat search] background indexing stopped:', e.message);
    }
}
setTimeout(drainIndex, 1000).unref?.();

// The list's columns. `nodeTitle` is read through the live node, so a renamed
// topic is named as it is now and a deleted one is simply absent.
const LIST_SQL = `
    SELECT c.id, c.title, c.node_id AS nodeId, n.title AS nodeTitle, n.project_id AS projectId,
           c.created_at AS createdAt, c.updated_at AS updatedAt,
           (SELECT COUNT(*) FROM chat_messages m WHERE m.conversation_id = c.id) AS messageCount
    FROM chat_conversations c
    LEFT JOIN live_nodes n ON n.id = c.node_id`;
const listAll = db.prepare(`${LIST_SQL} ORDER BY c.updated_at DESC, c.id DESC`);
const listSome = db.prepare(`${LIST_SQL} WHERE c.id IN (SELECT value FROM json_each(?))`);
/** Every title, newest first: matched in JavaScript, folded as the index folds. */
const titleList = db.prepare('SELECT id, title FROM chat_conversations ORDER BY updated_at DESC, id DESC');

/** Every conversation, newest first. */
export function listConversations() {
    return listAll.all();
}

/**
 * A few words of a message around its first matched word, and where the
 * matched words are in them (`[start, end)` offsets into `snippet`). Cut here
 * from the readable text rather than by FTS5's snippet(), which would show
 * the index's ё-less copy. A match the tokenizer found where this reading
 * finds none (a script written without spaces) shows the message's start.
 */
export function snippetOf(content, terms) {
    const text = searchableText(content);
    const parts = terms.flatMap(wordsOf);
    const words = [...text.matchAll(WORD_RE)].map(m => ({
        start: m.index, end: m.index + m[0].length, hit: parts.some(p => fold(m[0]).startsWith(p)),
    }));
    if (!words.length) return { snippet: text.slice(0, SNIPPET_CHARS), ranges: [] };
    const first = Math.max(0, words.findIndex(w => w.hit));
    const from = Math.max(0, first - SNIPPET_LEAD);
    let to = Math.min(words.length, from + SNIPPET_WORDS);
    while (to > first + 1 && words[to - 1].end - words[from].start > SNIPPET_CHARS) to--;
    const start = from === 0 ? 0 : words[from].start;
    const end = to === words.length ? text.length : words[to - 1].end;
    const head = start > 0 ? '…' : '';
    const body = text.slice(start, Math.min(end, start + SNIPPET_CHARS));
    const ranges = words.slice(from, to)
        .filter(w => w.hit && w.end - start <= body.length)
        .map(w => [w.start - start + head.length, w.end - start + head.length]);
    return { snippet: `${head}${body}${end < text.length ? '…' : ''}`, ranges };
}

/**
 * The conversations with a message (or a title) that holds every word of `q`, best first, at most
 * CHAT_SEARCH_LIMIT. Each is a list row plus `match`: the message that matched
 * best, with a snippet and the snippet's matched ranges, or null when only the
 * title matched.
 */
export function searchConversations(q) {
    const terms = queryTerms(q);
    if (!terms.length) return [];
    const parts = terms.map(wordsOf);

    // The best-ranked message of each conversation, in rank order.
    const best = new Map();
    let s = null;
    try {
        s = statements();
        refreshIndex();
        for (const hit of s.hits.all(terms.map(ftsTerm).join(' '), CHAT_SEARCH_LIMIT)) best.set(hit.conversationId, hit);
    } catch (e) {
        console.error('[chat search] searching titles only:', e.message);
        best.clear();
    }
    const byTitle = titleList.all().filter(c => titleMatches(c.title, parts)).map(c => c.id);
    const order = [...new Set([...byTitle, ...best.keys()])].slice(0, CHAT_SEARCH_LIMIT);
    if (!order.length) return [];

    const rows = listSome.all(JSON.stringify(order));
    const byId = new Map(rows.map(r => [r.id, r]));
    const matchOf = (id) => {
        const hit = best.get(id);
        if (!hit) return null;
        const content = s?.content.get(hit.messageId)?.content ?? '';
        return { messageId: hit.messageId, role: hit.role, ...snippetOf(content, terms) };
    };
    return order.filter(id => byId.has(id)).map(id => ({ ...byId.get(id), match: matchOf(id) }));
}
