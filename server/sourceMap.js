// server/sourceMap.js — what a document is MADE OF: its sections, in reading
// order, each with the pages (or the stretch of text) it covers.
//
// A course built from a book has to follow the book, and the book already says
// how it is organised. Three readings, best first:
//
//   1. bookmarks — the PDF's own outline. Exact: every entry names the page it
//      opens on, and pdf.js resolves it. A typeset book almost always has one.
//   2. contents  — the printed Contents page, for a PDF without bookmarks: lines
//      that end in a page number, at the front of the book, mapped from the
//      PRINTED page number to the physical page through the PDF's page labels or,
//      without labels, through where the titles are actually found.
//   3. headings  — numbered headings in the running text ("2.3 Pointers"),
//      kept only while their numbers count up, so a numbered list in a paragraph
//      does not become a chapter. Also Markdown headings, slides and sheets.
//
// Anything else is a document with no map; it still counts as one section, the
// whole document, and is read from excerpts.
//
// Everything here is bounded: entries walked, sections kept, title length.
// Titles come from whoever made the file, so they are flattened to one line
// here and quoted as data wherever they reach a prompt (sourceMaterial.js).

/** Sections a map keeps. A 600-page reference book has a few hundred. */
export const MAX_SECTIONS = 400;
/** Outline entries walked before giving up on the rest (a hostile file can hold millions). */
const MAX_OUTLINE_WALK = 2000;
/** Deepest outline level read (0 = top). */
const MAX_DEPTH = 3;
const TITLE_MAX = 160;

/** One line, no control characters, bounded. A title is data, never markup. */
export function cleanTitle(raw) {
    return String(raw ?? '')
        // Control characters and the two Unicode line/paragraph separators.
        .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, TITLE_MAX);
}

// ---- pages ----------------------------------------------------------------------

/**
 * Where each page sits in a PDF's extracted text. pdf-parse joins pages with
 * `\n-- N of T --\n` after page N (its default `pageJoiner`), and extract.js
 * stores that text as it is, so the marks survive into `documents.content`.
 * Returns `[{page, start, end}]` in order — `[]` for text with no marks (not a
 * PDF, or one whose text was rebuilt without them).
 */
export function pageSpans(text) {
    const s = String(text || '');
    const re = /(?:^|\n)-- (\d+) of (\d+) --(?=\n|$)/g;
    const spans = [];
    let prev = 0;
    let m;
    while ((m = re.exec(s))) {
        spans.push({ page: Number(m[1]), start: prev, end: m.index });
        prev = m.index + m[0].length;
    }
    return spans;
}

/** The page a character offset falls on, or null without page marks. */
export function pageAt(spans, offset) {
    if (!spans.length) return null;
    let lo = 0;
    let hi = spans.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (spans[mid].end < offset) lo = mid + 1;
        else hi = mid;
    }
    return spans[lo].page;
}

/** The text of one page without its mark, or ''. */
const pageText = (text, span) => (span ? String(text).slice(span.start, span.end) : '');

/** Text with the page marks taken out, for an excerpt a person reads. */
export function withoutPageMarks(text) {
    return String(text || '').replace(/(?:^|\n)-- \d+ of \d+ --(?=\n|$)/g, '\n');
}

// ---- 1. bookmarks ---------------------------------------------------------------

/**
 * The outline and title a parsed PDF carries. `parser` is a pdf-parse PDFParse
 * whose document is already loaded (extract.js calls this after getText, so the
 * file is parsed once). Never throws; a PDF with nothing returns empties.
 *
 * @returns {Promise<{ title: string, outline: {depth:number, title:string, page:number|null}[], labels: string[]|null }>}
 */
export async function readPdfStructure(parser) {
    const out = { title: '', outline: [], labels: null };
    try {
        const info = await parser.getInfo();
        out.title = cleanTitle(info?.info?.Title || metadataTitle(info?.metadata));
        const doc = parser.doc;
        try { out.labels = (await doc?.getPageLabels?.()) || null; } catch { out.labels = null; }
        let walked = 0;
        const pageOf = async (dest) => {
            try {
                const d = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
                if (!Array.isArray(d) || d[0] == null) return null;
                if (typeof d[0] === 'number') return d[0] + 1;
                return (await doc.getPageIndex(d[0])) + 1;
            } catch { return null; }
        };
        const walk = async (items, depth) => {
            for (const it of items || []) {
                if (walked >= MAX_OUTLINE_WALK || out.outline.length >= MAX_SECTIONS) return;
                walked++;
                const title = cleanTitle(it?.title);
                if (title) out.outline.push({ depth, title, page: await pageOf(it?.dest) });
                if (depth < MAX_DEPTH) await walk(it?.items, depth + 1);
            }
        };
        await walk(info?.outline, 0);
    } catch { /* a PDF whose info cannot be read has no outline; the text still stands */ }
    return out;
}

function metadataTitle(metadata) {
    try { return metadata?.get?.('dc:title') || ''; } catch { return ''; }
}

// ---- 2. a printed Contents page -------------------------------------------------

// The heading a Contents page opens with, in the catalog's languages.
const CONTENTS_HEADING = /^(?:table of contents|contents|brief contents|inhoud(?:sopgave|stafel)?|inhaltsverzeichnis|inhalt|table des mati[eè]res|sommaire|[ií]ndice(?: general)?|sum[aá]rio|spis tre[sś]ci|obsah|cuprins|sis[aä]llys|inneh[aå]ll|innhold|indholdsfortegnelse|i[cç]indekiler|содержание|оглавление|зм[іi]ст|περιεχόμενα|目次|目录|目錄|차례|목차)$/i;
// A line that ends in a page number, arabic or roman, after dots or spaces.
const ENTRY_LINE = /^(.{2,160}?)[\s.·…_]+(\d{1,4}|[ivxlcdm]{1,7})$/i;
const PART_WORD = /^(?:part|level|unit|book|deel|teil|partie|parte|cz[eę][sś][cć]|часть|частина|розд[іi]л)\s+[\divxlcdm]+\b/i;
const CHAPTER_WORD = /^(?:chapter|hoofdstuk|kapitel|chapitre|cap[ií]tulo|capitolo|rozdzia[lł]|глава)\s+\d+/i;
const NUMBERED = /^(\d{1,3}(?:\.\d{1,3}){0,3})\.?\s+\S/;

function isRunningHead(line) {
    const s = line.replace(/\s+/g, ' ').trim();
    // "vi CONTENTS", "CONTENTS vii", a bare page number.
    return /^\d{1,4}$/.test(s) || /^[ivxlcdm]{1,7}$/i.test(s)
        || CONTENTS_HEADING.test(s.replace(/^(?:\d{1,4}|[ivxlcdm]{1,7})\s+|\s+(?:\d{1,4}|[ivxlcdm]{1,7})$/gi, ''));
}

function entryLines(text) {
    const lines = String(text).split('\n').map(l => l.trim()).filter(Boolean);
    const entries = [];
    for (const line of lines) {
        if (isRunningHead(line)) continue;
        const m = ENTRY_LINE.exec(line);
        if (!m) continue;
        const title = m[1].replace(/[\s.·…_]+$/, '').trim();
        if (!/\p{L}/u.test(title)) continue;
        entries.push({ title, printed: m[2] });
    }
    return { entries, lines: lines.length };
}

const romanValue = (s) => {
    const v = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
    let total = 0;
    const t = s.toLowerCase();
    for (let i = 0; i < t.length; i++) {
        const a = v[t[i]], b = v[t[i + 1]] || 0;
        total += a < b ? -a : a;
    }
    return total;
};

/**
 * The entries of a printed Contents, read from the first pages of a PDF's text,
 * with each printed page number turned into a physical page. [] when there is
 * no Contents to read.
 */
export function printedContents(text, { labels = null } = {}) {
    const spans = pageSpans(text);
    if (!spans.length) return [];
    const scanUpTo = Math.min(spans.length, Math.max(12, Math.min(40, Math.ceil(spans.length * 0.15))));
    let start = -1;
    for (let i = 0; i < scanUpTo; i++) {
        const head = pageText(text, spans[i]).split('\n').map(l => l.trim()).filter(Boolean).slice(0, 3);
        if (head.some(l => CONTENTS_HEADING.test(l.replace(/[:.]$/, '')))) { start = i; break; }
    }
    if (start < 0) return [];

    const raw = [];
    for (let i = start; i < spans.length && i < start + 20; i++) {
        const { entries, lines } = entryLines(pageText(text, spans[i]));
        // A Contents page is mostly entries; the first prose page ends the run.
        if (i > start && (lines === 0 || entries.length / lines < 0.4)) break;
        raw.push(...entries);
        if (raw.length >= MAX_SECTIONS) break;
    }
    if (raw.length < 3) return [];

    // Depth from the numbering: a part opens a level above the chapters.
    const hasParts = raw.some(e => PART_WORD.test(e.title));
    const base = hasParts ? 1 : 0;
    const sections = raw.slice(0, MAX_SECTIONS).map(e => {
        let depth = base;
        if (PART_WORD.test(e.title)) depth = 0;
        else if (CHAPTER_WORD.test(e.title)) depth = base;
        else {
            const n = NUMBERED.exec(e.title);
            if (n) depth = base + n[1].split('.').length - 1;
        }
        return { depth: Math.min(depth, MAX_DEPTH), title: cleanTitle(e.title), printed: e.printed };
    });

    const physical = printedToPhysical(sections, { text, spans, labels, after: spans[start].page });
    return sections.map((s, i) => ({ depth: s.depth, title: s.title, page: physical[i] }));
}

/**
 * Printed page → physical page. Labels decide it when the PDF has them; else
 * the offset that most of the sampled titles are actually found at; else none
 * (printed numbers are kept as they are only when they could plausibly be
 * physical, never past the last page).
 */
function printedToPhysical(sections, { text, spans, labels, after }) {
    const last = spans[spans.length - 1].page;
    if (Array.isArray(labels) && labels.some(Boolean)) {
        return sections.map(s => {
            const want = String(s.printed).toLowerCase();
            // Arabic numbers repeat only in odd books; take the first one past the Contents.
            for (let i = after; i < labels.length; i++) if (String(labels[i] || '').toLowerCase() === want) return i + 1;
            for (let i = 0; i < labels.length; i++) if (String(labels[i] || '').toLowerCase() === want) return i + 1;
            return null;
        });
    }
    const arabic = sections.map(s => (/^\d+$/.test(s.printed) ? Number(s.printed) : null));
    const offsets = new Map();
    const norm = (s) => s.toLowerCase().replace(/^[\d.\s]+/, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    let sampled = 0;
    for (let i = 0; i < sections.length && sampled < 12; i++) {
        if (arabic[i] == null) continue;
        const needle = norm(sections[i].title);
        if (needle.length < 6) continue;
        sampled++;
        for (let p = Math.max(after, arabic[i] - 5); p <= Math.min(last, arabic[i] + 60); p++) {
            const span = spans.find(sp => sp.page === p);
            const head = norm(pageText(text, span).split('\n').slice(0, 6).join(' '));
            if (head.includes(needle)) {
                const off = p - arabic[i];
                offsets.set(off, (offsets.get(off) || 0) + 1);
                break;
            }
        }
    }
    let best = null, votes = 0;
    for (const [off, n] of offsets) if (n > votes) { best = off; votes = n; }
    return sections.map((s, i) => {
        if (/^[ivxlcdm]+$/i.test(s.printed) && !/^\d+$/.test(s.printed)) {
            const r = romanValue(s.printed);
            return r >= 1 && r <= last ? r : null;
        }
        if (arabic[i] == null) return null;
        const p = arabic[i] + (best ?? 0);
        return p >= 1 && p <= last ? p : null;
    });
}

// ---- 3. headings in the text ----------------------------------------------------

const HEADING_LINE = /^(\d{1,2}(?:\.\d{1,2}){0,2})\.?\s+(\p{Lu}[^\n]{1,88})$/u;

/** Does `next` follow `prev` in a heading numbering? (1 → 2, 1 → 1.1, 1.2 → 2, 2.3 → 2.4) */
function follows(prev, next) {
    if (!prev) return next.length === 1 ? next[0] <= 2 : next.every(n => n === 1);
    if (next.length === prev.length + 1) return next.slice(0, -1).every((n, i) => n === prev[i]) && next[next.length - 1] === 1;
    if (next.length > prev.length + 1) return false;
    const k = next.length - 1;
    return next.slice(0, k).every((n, i) => n === prev[i]) && next[k] === prev[k] + 1;
}

/**
 * Sections from the running text: Markdown headings, the slide and sheet marks
 * extract.js writes, or numbered headings whose numbers count up.
 * Each carries the character offset it starts at.
 */
export function textHeadings(text, kind = 'text') {
    const s = String(text || '');
    const out = [];
    const push = (depth, title, start) => {
        const t = cleanTitle(title);
        if (t && out.length < MAX_SECTIONS) out.push({ depth: Math.min(depth, MAX_DEPTH), title: t, start });
    };
    const lines = [];
    let pos = 0;
    for (const raw of s.split('\n')) {
        lines.push({ text: raw.trim(), start: pos });
        pos += raw.length + 1;
    }

    if (kind === 'pptx' || kind === 'xlsx') {
        for (let i = 0; i < lines.length; i++) {
            const slide = /^## Slide (\d+)$/.exec(lines[i].text);
            const sheet = /^## Sheet: (.+)$/.exec(lines[i].text);
            if (slide) {
                const first = (lines[i + 1]?.text || '').replace(/^Notes:.*$/, '');
                push(0, first ? `${slide[1]}. ${first.slice(0, 80)}` : `Slide ${slide[1]}`, lines[i].start);
            } else if (sheet) push(0, sheet[1], lines[i].start);
        }
        return out;
    }

    // Markdown only in a text file, and never a preprocessor line: a PDF of a
    // C book is full of "# define".
    const md = kind === 'text'
        ? lines.filter(l => /^#{1,3}\s+\S/.test(l.text) && !/^#\s*(?:define|include|if|ifn?def|endif|else|elif|error|pragma|undef|line|import)\b/.test(l.text))
        : [];
    if (md.length >= 2) {
        for (const l of md) push(l.text.match(/^#+/)[0].length - 1, l.text.replace(/^#+\s+/, '').replace(/\s+#+$/, ''), l.start);
        return out;
    }

    let prev = null;
    for (const l of lines) {
        // A trailing page number is a Contents line, not the heading itself.
        if (l.text.length > 90 || /[.:;,]$/.test(l.text) || /\s(?:\d{1,4}|[ivxlcdm]{1,7})$/i.test(l.text)) continue;
        const h = HEADING_LINE.exec(l.text);
        if (!h) continue;
        const nums = h[1].split('.').map(Number);
        if (!follows(prev, nums)) continue;
        prev = nums;
        // A run-in heading ("2.1. Grammar. Looking at…") ends at its own full stop.
        const runIn = /^(.+?\p{L}{2,})\.\s+\S/u.exec(h[2]);
        push(nums.length - 1, `${h[1]}. ${runIn ? runIn[1] : h[2]}`, l.start);
    }
    return out.length >= 2 ? out : [];
}

// ---- the map ---------------------------------------------------------------------

/**
 * A plain, suggestable title for a document: its own metadata title when that
 * is a real one, else its file name made readable.
 */
export function suggestTitle({ metaTitle = '', filename = '' } = {}) {
    const meta = realMetaTitle(metaTitle);
    if (meta) return meta;
    const base = String(filename || '').replace(/\.[a-z0-9]{1,5}$/i, '');
    return cleanTitle(base.replace(/[_]+/g, ' ').replace(/(?<=\p{L})-(?=\p{L})/gu, ' ').replace(/\s+/g, ' ')) || 'Document';
}

/** A document's own title when it is a real one, else ''. */
function realMetaTitle(metaTitle) {
    const meta = cleanTitle(metaTitle).replace(/^microsoft (?:word|powerpoint|excel) - /i, '');
    const junk = /^(?:untitled|document|title|presentation|slide ?\d*|book\d*|unknown|none|n\/a)$/i;
    const looksLikeFile = /\.(?:docx?|pdf|pptx?|xlsx?|tex|dvi|indd|qxd|txt|md)$/i;
    return meta.length >= 3 && /\p{L}{2}/u.test(meta) && !junk.test(meta) && !looksLikeFile.test(meta) ? meta : '';
}

/**
 * Close each section's range: it ends where the next section at its own level
 * or above begins, else where the document ends. Works on whichever coordinate
 * the sections carry (`page`, `start`).
 */
function closeRanges(sections, { lastPage = null, textLength = 0 } = {}) {
    return sections.map((sec, i) => {
        let endPage = lastPage;
        let end = textLength;
        for (let j = i + 1; j < sections.length; j++) {
            if (sections[j].depth <= sec.depth) {
                if (sections[j].page != null && sec.page != null) endPage = Math.max(sec.page, sections[j].page - 1);
                if (sections[j].start != null) end = sections[j].start;
                break;
            }
        }
        return { ...sec, endPage: sec.page != null ? endPage : null, end: sec.start != null ? end : null };
    });
}

/**
 * The source map of one extracted document.
 *
 * @param {{ text: string, kind: string, meta?: object, filename?: string }} doc
 * @returns {{ title: string, method: 'bookmarks'|'contents'|'headings'|'none', pages: number|null,
 *             sections: { depth: number, title: string, from: number|null, to: number|null,
 *                         start: number|null, end: number|null }[] }}
 */
export function buildSourceMap({ text = '', kind = 'text', meta = {}, filename = '' } = {}) {
    const structure = meta?.structure || {};
    const spans = pageSpans(text);
    const lastPage = spans.length ? spans[spans.length - 1].page : (meta?.pageCount ?? null);
    const startOfPage = (p) => spans.find(sp => sp.page === p)?.start ?? null;
    const title = suggestTitle({ metaTitle: structure.title, filename });

    let method = 'none';
    let sections = [];
    const outline = (structure.outline || []).filter(e => e.page != null);
    if (outline.length >= 2) {
        method = 'bookmarks';
        sections = outline.map(e => ({ depth: e.depth, title: e.title, page: e.page, start: startOfPage(e.page) }));
    } else if (kind === 'pdf') {
        const printed = printedContents(text, { labels: structure.labels }).filter(e => e.page != null);
        if (printed.length >= 3) {
            method = 'contents';
            sections = printed.map(e => ({ depth: e.depth, title: e.title, page: e.page, start: startOfPage(e.page) }));
        }
    }
    if (!sections.length) {
        const heads = textHeadings(text, kind);
        if (heads.length) {
            method = 'headings';
            sections = heads.map(h => ({ depth: h.depth, title: h.title, page: spans.length ? pageAt(spans, h.start) : null, start: h.start }));
        }
    }

    // Reading order is page order; an outline that jumps back (an appendix
    // bookmarked first) keeps its own order, which is the author's.
    const closed = closeRanges(sections.slice(0, MAX_SECTIONS), { lastPage, textLength: String(text).length });
    return {
        title,
        // The document's own title, or one made from its file name: only the
        // first is offered as the course's name before anything is generated.
        titleFrom: realMetaTitle(structure.title) ? 'metadata' : 'filename',
        method,
        pages: lastPage,
        sections: closed.map(s => ({
            depth: s.depth,
            title: s.title,
            from: s.page ?? null,
            to: s.endPage ?? null,
            start: s.start ?? null,
            end: s.end ?? null,
        })),
    };
}

/**
 * The text a section covers, without page marks, for an excerpt. `max` bounds
 * what is cut out before anything else happens to it.
 */
export function sectionText(text, section, max = 4000) {
    const s = String(text || '');
    if (section?.start == null) return '';
    const end = section.end != null ? Math.min(section.end, section.start + max * 2) : section.start + max * 2;
    return withoutPageMarks(s.slice(section.start, end)).replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}
