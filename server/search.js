// server/search.js — Unified search engine with fuzzy matching
//
// Strategies (ordered by speed, applied progressively):
//   1. Exact / case-insensitive match  (O(n) scan, instant)
//   2. LIKE-wildcard substring         (O(n) scan, fast)
//   3. Word-boundary prefix match       (O(n·w) where w = words)
//   4. Trigram similarity ≥ 0.25       (O(n·t) where t = trigrams)
//   5. Levenshtein distance ≤ 2         (O(n·m) per candidate)
//
// Scoring:
//   fieldWeight × matchTypeMultiplier × positionBonus
//
// Multi-token queries ("machine learning"):
//   AND-semantics — every token must match at least one field.
//   Score = weighted average of per-token scores with a proximity bonus
//   when tokens match in the same field.

import db from './database.js';

// Every result row is decorated with its project's name and colour, and all four
// call sites used to do `db.prepare('SELECT name, color FROM projects ...')`
// INSIDE the per-row loop — so a search re-compiled the same statement once per
// result and re-queried a table with a handful of rows. `quickSuggest` runs on
// every keystroke, which is where that actually costs something.
//
// The statement is prepared once at module load; the lookup is memoized in a Map
// created fresh inside each search function, because many results share a
// project. The cache is deliberately per-call and NOT module-level — a
// module-level one would keep serving a renamed or recoloured project's old
// name until the process restarts.
const projectMetaStmt = db.prepare('SELECT name, color FROM projects WHERE id = ?');

function projectMeta(cache, projectId) {
    if (projectId == null) return undefined;
    if (!cache.has(projectId)) cache.set(projectId, projectMetaStmt.get(projectId));
    return cache.get(projectId);
}

//
// Constants
//

const FIELD_WEIGHTS = {
    title: 3.0,
    name: 3.0,
    summary: 2.0,
    description: 2.0,
    notes: 1.0,
    content: 1.0,
    front: 1.5,
    back: 1.5,
    url: 0.5,
    question: 1.5,
};

const MIN_TRIGRAM_SIMILARITY = 0.22;
const MAX_LEVENSHTEIN_DISTANCE = 2;
const MIN_QUERY_LENGTH = 2;

//
// Levenshtein Distance (two-row DP, O(min(m,n)) space)
//

export function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;

    // Ensure `a` is shorter for space optimisation
    if (a.length > b.length) [a, b] = [b, a];

    const aLen = a.length;
    const bLen = b.length;
    let prev = new Uint16Array(aLen + 1);
    let curr = new Uint16Array(aLen + 1);

    for (let i = 0; i <= aLen; i++) prev[i] = i;

    for (let j = 1; j <= bLen; j++) {
        curr[0] = j;
        const bj = b[j - 1];
        for (let i = 1; i <= aLen; i++) {
            curr[i] = a[i - 1] === bj
                ? prev[i - 1]
                : 1 + Math.min(prev[i - 1], prev[i], curr[i - 1]);
        }
        [prev, curr] = [curr, prev];
    }
    return prev[aLen];
}

//
// Trigram Similarity
//

function trigramSet(str) {
    const s = new Set();
    const padded = `  ${str} `;
    for (let i = 0; i <= padded.length - 3; i++) s.add(padded.slice(i, i + 3));
    return s;
}

function trigramSimilarity(a, b) {
    const sa = trigramSet(a);
    const sb = trigramSet(b);
    if (sa.size === 0 || sb.size === 0) return 0;
    let hit = 0;
    for (const t of sa) { if (sb.has(t)) hit++; }
    return hit / Math.max(sa.size, sb.size);
}

//
// Word-boundary extraction
//

/**
 * Split a query or a field into searchable words.
 *
 * Keeps every LETTER and DIGIT in any script, and treats everything else as a
 * separator. The rule used to be an allowlist \u2014 `a-z0-9`, Latin-1 Supplement
 * and Extended-A, CJK ideographs \u2014 which silently deleted every other
 * alphabet before the length filter ran, so a query in one of them became zero
 * tokens and `searchAll` returned an empty result for every table. Cyrillic
 * (a Russian course), kana (hiragana and katakana are NOT inside
 * \u4e00-\u9fff, so a Japanese deck was findable by kanji but not by the
 * reading), Greek, Hebrew, Arabic, Hangul \u2014 all unsearchable, and indis-
 * tinguishable from "nothing matched".
 *
 * `\p{L}` and `\p{N}` need the `u` flag; they cover the accented Latin the old
 * ranges were there for, so nothing that worked before changes.
 */
export function extractWords(str) {
    return String(str ?? '').toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .split(/\s+/)
        .filter(w => w.length >= MIN_QUERY_LENGTH);
}

//
// Single-token matching against one text field
// Returns { score, matchType } or null
//

function matchToken(token, text) {
    const lt = token.toLowerCase();
    const ltext = text.toLowerCase();
    if (lt.length < MIN_QUERY_LENGTH) return null;

    // 1. Exact
    if (ltext === lt)
        return { score: 1.0, matchType: 'exact' };

    // 2. Contains
    const idx = ltext.indexOf(lt);
    if (idx !== -1) {
        const posBonus = 1 - Math.min(idx / ltext.length, 0.4);
        return { score: 0.70 + posBonus * 0.10, matchType: 'contains' };
    }

    // 3. Word-start prefix
    const words = extractWords(text);
    let bestWordScore = 0;
    for (const w of words) {
        if (w.startsWith(lt)) {
            const score = 0.55 + (lt.length / w.length) * 0.10;
            if (score > bestWordScore) bestWordScore = score;
        }
    }
    if (bestWordScore > 0)
        return { score: bestWordScore, matchType: 'wordStart' };

    // 4. Trigram
    const tri = trigramSimilarity(lt, ltext);
    if (tri >= MIN_TRIGRAM_SIMILARITY)
        return { score: tri * 0.55, matchType: 'trigram' };

    // 5. Levenshtein — only for short candidates to limit cost
    if (ltext.length <= lt.length + MAX_LEVENSHTEIN_DISTANCE + 5) {
        const d = levenshtein(lt, ltext);
        if (d <= MAX_LEVENSHTEIN_DISTANCE) {
            const maxLen = Math.max(lt.length, ltext.length);
            return { score: (1 - d / maxLen) * 0.45, matchType: 'levenshtein' };
        }
    }

    return null;
}

//
// Multi-token matching against a single field
// Returns the average score across all tokens, or null if any token
// fails to match.
//

function matchTokensInField(tokens, text) {
    if (!text) return null;
    let total = 0;
    let bestType = 'exact';
    const typeRank = { exact: 0, contains: 1, wordStart: 2, trigram: 3, levenshtein: 4 };

    for (const tok of tokens) {
        const m = matchToken(tok, text);
        if (!m) return null;
        total += m.score;
        if (typeRank[m.matchType] > (typeRank[bestType] ?? 99))
            bestType = m.matchType;
    }
    return { score: total / tokens.length, matchType: bestType };
}

//
// Score a single entity against a multi-token query
// fields: { fieldName: fieldValue, ... }
// Returns { score, bestField, matchType } or null
//

function scoreEntity(tokens, fields) {
    let bestScore = 0;
    let bestField = null;
    let bestType = null;
    const typeRank = { exact: 0, contains: 1, wordStart: 2, trigram: 3, levenshtein: 4 };

    for (const [name, value] of Object.entries(fields)) {
        if (value == null) continue;
        const m = matchTokensInField(tokens, String(value));
        if (!m) continue;
        const weight = FIELD_WEIGHTS[name] ?? 1.0;
        const scored = m.score * weight;
        if (scored > bestScore) {
            bestScore = scored;
            bestField = name;
            bestType = m.matchType;
        }
    }

    if (bestScore === 0) return null;
    return { score: bestScore, bestField, matchType: bestType };
}

//
// Highlight helper: find character ranges that matched
// Returns array of { start, end } for highlighting
//

function findMatchRanges(query, text) {
    const ranges = [];
    const tokens = extractWords(query);
    const ltext = text.toLowerCase();

    for (const tok of tokens) {
        const lt = tok.toLowerCase();
        let start = 0;
        while (true) {
            const idx = ltext.indexOf(lt, start);
            if (idx === -1) break;
            ranges.push({ start: idx, end: idx + lt.length });
            start = idx + 1;
        }
    }

    // Merge overlapping ranges
    if (ranges.length === 0) return [];
    ranges.sort((a, b) => a.start - b.start);
    const merged = [ranges[0]];
    for (let i = 1; i < ranges.length; i++) {
        const last = merged[merged.length - 1];
        if (ranges[i].start <= last.end) {
            last.end = Math.max(last.end, ranges[i].end);
        } else {
            merged.push(ranges[i]);
        }
    }
    return merged;
}

//
// Public search functions
//

/**
 * Search across all entities.
 *
 * @param {string} query  - Raw search string
 * @param {object} opts
 *   projectId {number|null} - Scope to one project
 *   limit     {number}      - Max results per category (default 10)
 * @returns {{ projects:[], nodes:[], resources:[], documents:[] }}
 */
export function searchAll(query, opts = {}) {
    const { projectId = null, limit = 10 } = opts;
    const tokens = extractWords(query);
    if (tokens.length === 0) return emptyResult();

    return {
        projects: searchProjects(tokens, limit),
        nodes: searchNodes(tokens, projectId, limit),
        resources: searchResources(tokens, projectId, limit),
        documents: searchDocuments(tokens, projectId, limit),
    };
}

function emptyResult() {
    return { projects: [], nodes: [], resources: [], documents: [] };
}

function searchProjects(tokens, limit) {
    const rows = db.prepare(`
        SELECT id, name, description, summary, color, icon
        FROM projects
    `).all();

    return rankAndSlice(rows, tokens, r => ({
        name: r.name,
        description: r.description,
        summary: r.summary,
    }), r => ({
        type: 'project',
        projectId: r.id,
        title: r.name,
        color: r.color,
        icon: r.icon,
        matchField: null,
        snippet: '',
        matchRanges: [],
    }), limit);
}

function searchNodes(tokens, projectId, limit) {
    const pCache = new Map();
    let rows;
    if (projectId) {
        rows = db.prepare(`
            SELECT n.id, n.project_id, n.parent_id, n.title, n.description, n.notes, n.status
            FROM nodes n
            WHERE n.project_id = ? AND n.is_note = 0
        `).all(projectId);
    } else {
        rows = db.prepare(`
            SELECT n.id, n.project_id, n.parent_id, n.title, n.description, n.notes, n.status
            FROM nodes n
            WHERE n.is_note = 0
        `).all();
    }

    return rankAndSlice(rows, tokens, r => ({
        title: r.title,
        description: r.description,
        notes: r.notes,
    }), r => {
        const project = projectMeta(pCache, r.project_id);
        // Build snippet from best matching field
        const fields = { title: r.title, description: r.description, notes: r.notes };
        let bestField = 'title';
        let bestVal = r.title || '';
        let bestScore = 0;
        for (const [k, v] of Object.entries(fields)) {
            if (!v) continue;
            const m = matchTokensInField(tokens, v);
            const w = FIELD_WEIGHTS[k] ?? 1;
            if (m && m.score * w > bestScore) {
                bestScore = m.score * w;
                bestField = k;
                bestVal = v;
            }
        }
        const snippet = bestField === 'title'
            ? ''
            : bestVal.slice(0, 120).replace(/\n/g, ' ');
        const matchRanges = findMatchRanges(tokens.join(' '), snippet || r.title);

        return {
            type: 'node',
            projectId: r.project_id,
            projectName: project?.name,
            projectColor: project?.color,
            nodeId: r.id,
            title: r.title,
            status: r.status,
            matchField: bestField,
            snippet,
            matchRanges,
        };
    }, limit);
}

function searchResources(tokens, projectId, limit) {
    const pCache = new Map();
    let rows;
    if (projectId) {
        rows = db.prepare(`
            SELECT r.id, r.node_id, r.title, r.url, r.type,
                   n.project_id, n.title as node_title
            FROM resources r
            JOIN nodes n ON n.id = r.node_id
            WHERE n.project_id = ?
        `).all(projectId);
    } else {
        rows = db.prepare(`
            SELECT r.id, r.node_id, r.title, r.url, r.type,
                   n.project_id, n.title as node_title
            FROM resources r
            JOIN nodes n ON n.id = r.node_id
        `).all();
    }

    return rankAndSlice(rows, tokens, r => ({
        title: r.title,
        url: r.url,
    }), r => {
        const project = projectMeta(pCache, r.project_id);
        return {
            type: 'resource',
            projectId: r.project_id,
            projectName: project?.name,
            projectColor: project?.color,
            nodeId: r.node_id,
            nodeTitle: r.node_title,
            title: r.title,
            url: r.url,
            resourceType: r.type,
            matchField: 'title',
            snippet: '',
            matchRanges: findMatchRanges(tokens.join(' '), r.title),
        };
    }, limit);
}

function searchDocuments(tokens, projectId, limit) {
    const pCache = new Map();
    // Use FTS5 if available, otherwise LIKE
    const queryStr = tokens.join(' ');

    let rows;
    try {
        const ftsQuery = tokens.map(t => `${t}*`).join(' ');
        if (projectId) {
            rows = db.prepare(`
                SELECT d.id, d.title, d.node_id, d.project_id,
                       dc.content as snippet
                FROM documents_fts fts
                JOIN document_chunks dc ON dc.id = fts.rowid
                JOIN documents d ON d.id = dc.document_id
                WHERE documents_fts MATCH ?
                  AND d.project_id = ?
                ORDER BY rank
                LIMIT ?
            `).all(ftsQuery, projectId, limit * 3);
        } else {
            rows = db.prepare(`
                SELECT d.id, d.title, d.node_id, d.project_id,
                       dc.content as snippet
                FROM documents_fts fts
                JOIN document_chunks dc ON dc.id = fts.rowid
                JOIN documents d ON d.id = dc.document_id
                WHERE documents_fts MATCH ?
                ORDER BY rank
                LIMIT ?
            `).all(ftsQuery, limit * 3);
        }
    } catch {
        // FTS5 not available — fallback to LIKE
        const likeQuery = `%${queryStr}%`;
        if (projectId) {
            rows = db.prepare(`
                SELECT d.id, d.title, d.node_id, d.project_id,
                       SUBSTR(d.content, 1, 200) as snippet
                FROM documents d
                WHERE d.project_id = ?
                  AND (d.title LIKE ? OR d.content LIKE ?)
                LIMIT ?
            `).all(projectId, likeQuery, likeQuery, limit);
        } else {
            rows = db.prepare(`
                SELECT d.id, d.title, d.node_id, d.project_id,
                       SUBSTR(d.content, 1, 200) as snippet
                FROM documents d
                WHERE d.title LIKE ? OR d.content LIKE ?
                LIMIT ?
            `).all(likeQuery, likeQuery, limit);
        }
    }

    // Deduplicate by document id (multiple chunks may match)
    const seen = new Set();
    const results = [];
    for (const r of rows) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);

        const project = projectMeta(pCache, r.project_id);
        results.push({
            type: 'document',
            projectId: r.project_id,
            projectName: project?.name,
            projectColor: project?.color,
            documentId: r.id,
            nodeId: r.node_id,
            title: r.title,
            matchField: 'content',
            snippet: (r.snippet || '').slice(0, 150).replace(/\n/g, ' '),
            matchRanges: findMatchRanges(queryStr, (r.snippet || '').slice(0, 150)),
            score: 0.5, // FTS5 already ranked these
        });
    }

    return results.slice(0, limit);
}

function rankAndSlice(rows, tokens, fieldsFn, mapFn, limit) {
    const scored = [];

    for (const row of rows) {
        const fields = fieldsFn(row);
        const result = scoreEntity(tokens, fields);
        if (!result) continue;

        const item = mapFn(row);
        item.score = result.score;
        item.matchField = item.matchField || result.bestField;
        scored.push(item);
    }

    // Sort by score descending, then alphabetically for ties
    scored.sort((a, b) => b.score - a.score || (a.title || '').localeCompare(b.title || ''));

    return scored.slice(0, limit);
}

// Quick suggestions (for autocomplete-style results)

/**
 * Return top-N node titles matching a prefix.
 * Used for command-palette-style quick navigation.
 */
export function quickSuggest(prefix, projectId, limit = 8) {
    const pCache = new Map();
    const lp = prefix.toLowerCase().trim();
    if (lp.length < 1) return [];

    let rows;
    if (projectId) {
        rows = db.prepare(`
            SELECT n.id, n.title, n.status, n.project_id
            FROM nodes n
            WHERE n.project_id = ? AND n.is_note = 0 AND LOWER(n.title) LIKE ?
            ORDER BY
                CASE WHEN LOWER(n.title) = ? THEN 0
                     WHEN LOWER(n.title) LIKE ? THEN 1
                     ELSE 2 END,
                n.position
            LIMIT ?
        `).all(projectId, `${lp}%`, lp, `${lp}%`, limit);
    } else {
        rows = db.prepare(`
            SELECT n.id, n.title, n.status, n.project_id
            FROM nodes n
            WHERE n.is_note = 0 AND LOWER(n.title) LIKE ?
            ORDER BY
                CASE WHEN LOWER(n.title) = ? THEN 0
                     WHEN LOWER(n.title) LIKE ? THEN 1
                     ELSE 2 END,
                n.position
            LIMIT ?
        `).all(`${lp}%`, lp, `${lp}%`, limit);
    }

    return rows.map(r => {
        const project = projectMeta(pCache, r.project_id);
        return {
            type: 'node',
            projectId: r.project_id,
            projectName: project?.name,
            projectColor: project?.color,
            nodeId: r.id,
            title: r.title,
            status: r.status,
        };
    });
}

export default {
    searchAll,
    quickSuggest,
    levenshtein,
    trigramSimilarity,
    matchToken,
    scoreEntity,
    findMatchRanges,
};