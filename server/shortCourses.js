// server/shortCourses.js — a small course of its own from ONE source.
//
// A learner who pastes a link (a web page, a PDF, a YouTube video) or drops a
// file on Projects wants to learn what that one thing teaches, now, without
// planning a course: one level of 3–8 topics, sized by the source, each topic
// taught from the source's own part of it (`node_sources`), no dates, and a
// standing place in the feed (feed.js `isStanding`).
//
// A source is READ first (`readSource`), at the press of Read, and staged
// like a file dropped into the New course dialog (stagedDocuments.js): the
// learner sees its title and size before anything is made, and a source that
// cannot be read says why and what to do next (linkReader.js READ_REASONS).
// A title alone is never a source. The one exception is "Write it from the
// topic", which the learner presses on a video that has no captions, and the
// course it makes names no video anywhere: it was not built from one.
//
// Creating is ONE model call (`AI_PROMPTS.short_course`) with the source
// itself inside the SOURCES boundary (sourceMaterial.js `shortBlock`), run as
// a background task so the strip shows it being written and the dock can
// cancel it. `projects.made_from` says where a course came from and marks it
// as short; it stays on the strip until it grows a phase.

import db from './database.js';
import { AI_PROMPTS, aiProvenance, getAISettings } from './ai.js';
import { parseCreationJson } from './agentic.js';
import { promptTitle } from './citations.js';
import { structureCall } from './creationCalls.js';
import { languagesFromAcceptHeader, resolveCreationLanguage } from './creationLanguage.js';
import { getLanguage, getUiLanguage, withLearning } from './language.js';
import { findLearningLanguage } from './learningLanguage.js';
import { parseLink, readLink, wordCount } from './linkReader.js';
import { scheduleNodeSync } from './nodeEmbeddings.js';
import { addProvenanceFields } from './projectIdentity.js';
import { scheduleSearchWords } from './searchWords.js';
import { getSetting } from './settingsStore.js';
import { creationSources, hasSources, sectionRefs, shortBlock, sourceRanges, withoutSourceRefs } from './sourceMaterial.js';
import { buildSourceMap, pageSpans, withoutPageMarks } from './sourceMap.js';
import { claimStaged, discardStaged, loadStaged, stagedLanguage, stagedSummary, stageFile } from './stagedDocuments.js';
import * as tasks from './tasks.js';
import vaultStorage from './vaultStorage.js';

/** The bounds of a short course. Under `minWords` a source is a note (the
 *  Inbox); over `maxWords` it is a book, which wants a full course or a few of
 *  its chapters. */
export const SHORT = { minWords: 250, maxWords: 40000, minTopics: 3, maxTopics: 8 };

/**
 * How many topics a source of `words` words makes: one sitting per topic, and
 * a topic grows with the source more slowly than the source does (a 12-minute
 * video, ~1,800 words, is 3; a long article 5; a chapter 8).
 */
export function topicCountFor(words) {
    const n = Math.round(1.2 * Math.sqrt(Math.max(0, Number(words) || 0) / 300));
    return Math.min(SHORT.maxTopics, Math.max(SHORT.minTopics, n));
}

/** `'too-small'` (a note), `'ok'` or `'too-big'` (a book). */
export function sizeOf(words) {
    if (words < SHORT.minWords) return 'too-small';
    if (words > SHORT.maxWords) return 'too-big';
    return 'ok';
}

/** A short-course failure the route answers with: a status and a body. */
export class ShortCourseError extends Error {
    constructor(status, message, extra = {}) {
        super(message);
        this.status = status;
        this.extra = extra;
    }
}

export function aiReady() {
    try {
        const s = getAISettings();
        return !!(s.enabled && s.model);
    } catch {
        return false;
    }
}

// ---- reading a source -----------------------------------------------------------------

/** A video transcript's time marks, which are not words. */
const TIME_MARK = /\[\d{1,2}:\d\d(?::\d\d)?\]\s*/g;
const wordsOf = (text) => wordCount(withoutPageMarks(String(text || '')).replace(TIME_MARK, ' '));

/** A file name a page or a transcript is kept under in the vault. */
const fileNameFor = (title, ext) => `${String(title || 'source').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'source'}.${ext}`;

/** The first words of a part, for the § line that opens it. */
function partTitle(text) {
    const line = withoutPageMarks(text).replace(TIME_MARK, '').split('\n')
        .map(l => l.replace(/^\s*(?:#{1,6}\s+|[-*>]\s+)/, '').trim())
        .find(Boolean) || '';
    const words = line.split(/\s+/).filter(Boolean);
    return words.length > 9 ? `${words.slice(0, 9).join(' ')}…` : words.join(' ');
}

/**
 * Parts for a source with no headings to follow: a short course still cites
 * the part each topic teaches, so the text is cut in reading order, by pages
 * where it has them, else at paragraph, line or sentence ends, into twice as
 * many parts as it will have topics (a topic may take two).
 */
export function partsOf(text, words) {
    const want = Math.min(12, Math.max(2, topicCountFor(words) * 2));
    const spans = pageSpans(text);
    if (spans.length >= 2) {
        const per = Math.ceil(spans.length / want);
        const out = [];
        for (let i = 0; i < spans.length; i += per) {
            const group = spans.slice(i, i + per);
            const start = group[0].start;
            const end = group[group.length - 1].end;
            const first = group[0].page, last = group[group.length - 1].page;
            out.push({ depth: 0, title: partTitle(text.slice(start, end)) || (first === last ? `Page ${first}` : `Pages ${first}–${last}`), from: first, to: last, start, end });
        }
        return out;
    }
    const len = text.length;
    const breaksAt = (re) => [...text.matchAll(re)].map(m => m.index + m[0].length).filter(b => b > 0 && b < len);
    let breaks = breaksAt(/\n[ \t]*\n/g);
    if (breaks.length < want - 1) breaks = breaksAt(/\n/g);
    if (breaks.length < want - 1) breaks = breaksAt(/[.!?…]["'”’)]?\s+/g);
    const cuts = [0];
    for (let k = 1; k < want; k++) {
        const target = (len * k) / want;
        const last = cuts[cuts.length - 1];
        let best = null;
        for (const b of breaks) {
            if (b <= last) continue;
            if (best == null || Math.abs(b - target) < Math.abs(best - target)) best = b;
        }
        if (best != null) cuts.push(best);
    }
    cuts.push(len);
    const out = [];
    for (let i = 0; i + 1 < cuts.length; i++) {
        const slice = text.slice(cuts[i], cuts[i + 1]);
        if (!slice.trim()) continue;
        out.push({ depth: 0, title: partTitle(slice) || `Part ${out.length + 1}`, from: null, to: null, start: cuts[i], end: cuts[i + 1] });
    }
    return out;
}

const setStagedStmt = () => db.prepare('UPDATE staged_documents SET title = ?, source_map = ?, origin = ? WHERE id = ?');

/**
 * A staged source made ready for a short course: its title, the parts a
 * topic can cite, and where it came from. Returns the summary Read shows.
 */
function finishStaging(stagedId, origin) {
    const row = loadStaged([stagedId])[0];
    if (!row) throw new ShortCourseError(404, 'The source is no longer staged.');
    const map = { ...row.map };
    const title = String(origin.title || map.title || row.title).slice(0, 500);
    const words = wordsOf(row.content);
    if (!map.sections.length) {
        map.sections = partsOf(row.content, words);
        map.method = 'parts';
    }
    map.title = title;
    setStagedStmt().run(title, JSON.stringify(map), JSON.stringify(origin), stagedId);
    const size = sizeOf(words);
    return {
        ok: true,
        stagedId,
        kind: origin.kind,
        title,
        url: origin.url ?? null,
        host: origin.host ?? null,
        file: origin.file ?? null,
        words,
        pages: row.page_count ?? null,
        minutes: origin.minutes ?? null,
        captions: origin.captions ?? null,
        short: !!origin.short,
        size,
        topics: topicCountFor(words),
        sections: map.sections.length,
        method: map.method,
        language: origin.language ?? null,
        // Writing it needs a model; reading it did not.
        ai: aiReady(),
        // A book: its chapters to pick a few from, and the file as the New
        // course dialog takes it, for a full course instead.
        ...(size === 'too-big' ? {
            chapters: chaptersOf(row.content, map),
            staged: stagedSummary(loadStagedRow(stagedId)),
        } : {}),
    };
}

const loadStagedRow = (id) => db.prepare('SELECT * FROM staged_documents WHERE id = ?').get(id);

/** The top level of a source's parts, each with its own words, to pick from. */
function chaptersOf(text, map) {
    const top = Math.min(...map.sections.map(s => s.depth));
    const out = [];
    map.sections.forEach((s, i) => {
        if (s.depth !== top || s.start == null) return;
        const end = s.end ?? text.length;
        out.push({ part: i, title: String(s.title || '').slice(0, 200), from: s.from ?? null, to: s.to ?? null, words: wordsOf(text.slice(s.start, end)) });
    });
    return out.slice(0, 200);
}

/** The map cut to the chosen top-level parts and everything under them. */
function pickParts(map, picks) {
    const want = new Set((Array.isArray(picks) ? picks : []).map(Number).filter(Number.isInteger));
    if (!want.size) return null;
    const top = Math.min(...map.sections.map(s => s.depth));
    const keep = [];
    let inside = false;
    map.sections.forEach((s, i) => {
        if (s.depth === top) inside = want.has(i);
        if (inside) keep.push(s);
    });
    return keep.length ? { ...map, sections: keep } : null;
}

/** Stage bytes as a file; a file with no text says so and keeps nothing. */
async function stageBytes(buffer, filename, hint) {
    const staged = await stageFile(buffer, filename, Date.now(), { hint });
    if (!staged.ok) return { ok: false, reason: staged.reason === 'no_text' ? 'no_text' : 'unreadable', fix: null, title: staged.title };
    return staged;
}

const fileKind = (fileType) => (fileType === 'pdf' ? 'pdf' : 'file');

/**
 * Read a source and stage it. `{ url }` is read from the web (linkReader.js);
 * `{ transcript, title, url? }` is a transcript the learner pasted (from a
 * video whose captions could not be read); `{ buffer, filename }` a file.
 * Unreadable comes back `{ ok: false, reason, fix, title? }` and stages
 * nothing.
 */
export async function readSource({ url, transcript, title, buffer, filename } = {}, { acceptLanguage = '', signal } = {}) {
    const hint = getUiLanguage() || languagesFromAcceptHeader(acceptLanguage)[0] || null;
    if (typeof transcript === 'string' && transcript.trim()) {
        const text = transcript.replace(/\r\n?/g, '\n').trim().slice(0, 400_000);
        const link = url ? parseLink(url) : null;
        const at = link?.ok ? link : null;
        const name = String(title || '').trim().slice(0, 300) || partTitle(text) || 'Transcript';
        const staged = await stageBytes(Buffer.from(text, 'utf8'), fileNameFor(name, 'txt'), hint);
        if (!staged.ok) return staged;
        return finishStaging(staged.id, {
            kind: at?.video || !at ? 'video' : 'page',
            title: name,
            url: at ? at.url : null,
            host: at ? at.host : null,
            pasted: true,
        });
    }
    if (buffer) {
        const staged = await stageBytes(buffer, filename || 'file', hint);
        if (!staged.ok) return staged;
        return finishStaging(staged.id, { kind: fileKind(staged.file_type), title: staged.suggestedTitle || staged.title, file: String(filename || '').slice(0, 300) || null });
    }
    if (typeof url !== 'string' || !url.trim()) throw new ShortCourseError(400, 'A link, a transcript or a file is required.');
    const r = await readLink(url, { lang: hint?.code || 'en', signal });
    if (!r.ok) return { ok: false, reason: r.reason, fix: r.fix ?? null, title: r.title || null, url: r.url || null, host: r.host || null };
    if (r.kind === 'pdf' || r.kind === 'file') {
        const staged = await stageBytes(r.buffer, r.filename, hint);
        if (!staged.ok) return { ...staged, url: r.url, host: r.host };
        return finishStaging(staged.id, {
            kind: fileKind(staged.file_type),
            title: staged.suggestedTitle || staged.title,
            url: r.url,
            host: r.host,
            file: r.filename,
        });
    }
    // A page or a video's captions: kept in the vault as the text it was
    // read as, a page as markdown (its headings are what its parts follow).
    const isVideo = r.kind === 'video';
    const body = isVideo || /^#{1,6}\s/.test(r.text) ? r.text : `# ${r.title}\n\n${r.text}`;
    const staged = await stageBytes(Buffer.from(body, 'utf8'), fileNameFor(r.title, isVideo ? 'txt' : 'md'), hint);
    if (!staged.ok) return { ...staged, url: r.url, host: r.host };
    return finishStaging(staged.id, {
        kind: r.kind,
        title: r.title,
        url: r.url,
        host: r.host,
        ...(isVideo ? { minutes: r.minutes, captions: r.captions, short: !!r.short, language: r.language || null } : {}),
    });
}

// ---- creating one ----------------------------------------------------------------------

const cleanLine = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** The topics the assistant showed the learner, kept as shown: 2–8 titles. */
function proposedTopics(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const t of raw) {
        const title = cleanLine(typeof t === 'string' ? t : t?.title, 200);
        if (title && !out.includes(title)) out.push(title);
    }
    return out.length >= 2 ? out.slice(0, SHORT.maxTopics) : [];
}

/** What `made_from` keeps of a staged source's origin: where it came from, never its text. */
function madeFromOf(origin) {
    const out = { kind: origin.kind };
    if (origin.url) out.url = origin.url;
    if (origin.host) out.host = origin.host;
    if (origin.file) out.file = origin.file;
    if (origin.minutes) out.minutes = origin.minutes;
    return out;
}

const parseJson = (s) => { try { return JSON.parse(s || 'null'); } catch { return null; } };

/** The language a short course is written in: the learner's, as a new course decides it. */
function courseLanguage({ name, filesLanguage, acceptLanguage }) {
    const appLanguage = getUiLanguage();
    const browserLanguages = languagesFromAcceptHeader(acceptLanguage);
    const typed = findLearningLanguage({ name, description: '' });
    const choice = resolveCreationLanguage({
        name,
        filesLanguage,
        uiLanguage: appLanguage || browserLanguages[0] || null,
        appLanguage,
        browserLanguages,
        profile: getSetting('user_profile', ''),
        learning: typed.named,
    });
    const learning = typed.named && typed.named !== choice.code ? typed.named : '';
    return { code: choice.code, learning, lang: withLearning(choice.lang, getLanguage(learning)) };
}

/**
 * Make a short course and start writing it. One of:
 *   `{ stagedId }`            a source Read staged;
 *   `{ url }`                 a link (the assistant's), read and built in one press;
 *   `{ attachmentId }`        a file attached in the assistant chat;
 *   `{ fromTopic: { title } }` "Write it from the topic": no source at all.
 * `name` and `topics` are what the assistant showed, kept as shown.
 * Returns `{ projectId, taskId }`; throws a `ShortCourseError`.
 */
export async function createShortCourse(body = {}, { acceptLanguage = '', origin = { surface: 'projects' }, signal } = {}) {
    const { stagedId, url, attachmentId, fromTopic } = body || {};
    const given = cleanLine(body?.name, 500);
    const proposed = proposedTopics(body?.topics);

    // `once` (the assistant's card, drawn again on every re-read of the
    // conversation): a second press finds the course the first one made, by
    // its name and its source, before anything is read again.
    if (body?.once && given) {
        const existing = existingShortCourse({ name: given, url, attachmentId });
        if (existing) return { projectId: existing, taskId: null, existed: true };
    }

    let staged = null;
    let topicTitle = '';
    if (fromTopic && typeof fromTopic === 'object') {
        topicTitle = cleanLine(fromTopic.title, 300);
        if (!topicTitle) throw new ShortCourseError(400, 'A topic needs a title.');
    } else if (typeof stagedId === 'string' && stagedId) {
        staged = loadStaged([stagedId])[0] || null;
        if (!staged) throw new ShortCourseError(404, 'That source is no longer staged. Read it again.');
    } else if (attachmentId != null && attachmentId !== '') {
        const att = db.prepare('SELECT name, file_hash FROM chat_attachments WHERE id = ?').get(Number(attachmentId) || 0);
        const bytes = att?.file_hash ? vaultStorage.readBuffer(att.file_hash) : null;
        if (!bytes) throw new ShortCourseError(404, 'That file is no longer in the conversation.');
        if (!aiReady()) throw new ShortCourseError(409, 'No AI is connected.', { reason: 'no_ai' });
        const read = await readSource({ buffer: bytes, filename: att.name }, { acceptLanguage });
        if (!read.ok) throw new ShortCourseError(422, 'That file has no text to build a course from.', { reason: read.reason, fix: read.fix });
        staged = loadStaged([read.stagedId])[0];
    } else if (typeof url === 'string' && url.trim()) {
        if (!aiReady()) throw new ShortCourseError(409, 'No AI is connected.', { reason: 'no_ai' });
        const read = await readSource({ url }, { acceptLanguage, signal });
        if (!read.ok) throw new ShortCourseError(422, 'That link could not be read.', { reason: read.reason, fix: read.fix, title: read.title });
        staged = loadStaged([read.stagedId])[0];
    } else {
        throw new ShortCourseError(400, 'A short course is made from a source: a link, a file or a transcript.');
    }
    if (!aiReady()) throw new ShortCourseError(409, 'No AI is connected.', { reason: 'no_ai' });

    const sourceOrigin = staged ? (parseJson(staged.origin) || { kind: fileKind(staged.file_type), file: staged.original_filename }) : null;
    const madeFrom = staged ? madeFromOf(sourceOrigin) : { kind: 'topic', title: topicTitle };
    const sourceTitle = staged ? (staged.map.title || staged.title) : topicTitle;
    const name = given || sourceTitle;
    const language = courseLanguage({
        name: given,
        filesLanguage: staged ? stagedLanguage(staged.content, getUiLanguage()) : null,
        acceptLanguage,
    });
    // A few chapters of a book: only those reach the model and are cited.
    const picked = staged && body?.parts != null ? pickParts(staged.map, body.parts) : null;
    if (staged && body?.parts != null && !picked) throw new ShortCourseError(400, 'Pick at least one chapter.');
    // A page or a transcript is a text file in the vault; the model is told
    // what it really is.
    const asKind = sourceOrigin && ['page', 'video'].includes(sourceOrigin.kind) && staged.file_type === 'text' ? sourceOrigin.kind : staged?.file_type;
    const src = staged ? creationSources([{ ...staged, map: picked || staged.map, file_type: asKind }]) : null;
    if (picked) src.docs[0].picked = true;
    const words = !staged ? 0 : picked
        ? chaptersOf(staged.content, picked).reduce((n, c) => n + c.words, 0)
        : wordsOf(staged.content);

    const projectId = Number(db.prepare(`INSERT INTO projects
        (name, description, color, icon, position, content_language, learning_language, ai_generating, generated_by, made_from)
        VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM projects), ?, ?, 1, NULL, ?)`)
        .run(name.slice(0, 500), '', cleanLine(body?.color, 20) || '#3B82F6', cleanLine(body?.icon, 40) || 'book-open',
            language.code, language.learning, JSON.stringify(madeFrom)).lastInsertRowid);
    const claimed = staged ? claimStaged([staged.id], projectId) : new Map();
    const documentIdOf = (n) => claimed.get(src?.docs[n - 1]?.stagedId) ?? null;
    const taskId = startBuild({
        projectId, name, keepName: !!given, title: sourceTitle, proposed, src, documentIdOf,
        fromTopic: !staged, lang: language.lang, origin, words,
    });
    return { projectId, taskId };
}

/** The short course already made under `name` from this link or chat file, if one was. */
function existingShortCourse({ name, url, attachmentId }) {
    const link = typeof url === 'string' && url.trim() ? parseLink(url) : null;
    const file = attachmentId != null && attachmentId !== ''
        ? db.prepare('SELECT name FROM chat_attachments WHERE id = ?').get(Number(attachmentId) || 0)?.name ?? null
        : null;
    if (!link?.ok && !file) return null;
    for (const row of db.prepare('SELECT id, made_from FROM projects WHERE made_from IS NOT NULL AND name = ? ORDER BY id DESC').all(name)) {
        const from = parseJson(row.made_from) || {};
        if (link?.ok ? from.url === link.url : (!from.url && from.file === file)) return row.id;
    }
    return null;
}

/** Write a short course's topics: one model call, as a background task. */
function startBuild({ projectId, name, keepName, title, proposed, src, documentIdOf, fromTopic, lang, origin, words = 0 }) {
    const color = db.prepare('SELECT color FROM projects WHERE id = ?').get(projectId)?.color || null;
    const count = proposed.length || (src ? topicCountFor(words) : 4);
    const { task } = tasks.createTask({
        kind: 'short_course',
        label: 'Short course',
        labelKey: 'Short course',
        projectId,
        projectName: name.slice(0, 500),
        projectColor: color,
        origin: { ...origin, projectId },
        run: async ({ emit, signal }) => {
            try {
                emit({ phase: 'outline', message: 'Writing the topics…', percent: 10 });
                const prompt = AI_PROMPTS.short_course(promptTitle(title), {
                    topics: count, proposed, fromTopic, lang, sources: src ? shortBlock(src) : null,
                });
                const answered = {};
                const text = await structureCall(prompt, { signal, label: 'Short course', answered });
                const parsed = parseCreationJson(text);
                const items = topicsFrom(parsed, { src, proposed });
                if (!items.length) throw new Error('The model wrote no topics for this short course.');
                writeCourse({ projectId, items, parsed, keepName, src, documentIdOf, answered });
                emit({ phase: 'done', percent: 100 });
                return { projectId, topics: items.length };
            } finally {
                db.prepare('UPDATE projects SET ai_generating = 0 WHERE id = ?').run(projectId);
            }
        },
    });
    return task.id;
}

/** The topics from the model's answer: titles clean of § marks, cut to eight,
 *  each citing parts of the source (in order, when the model cited none). */
function topicsFrom(parsed, { src, proposed }) {
    const raw = Array.isArray(parsed?.topics) ? parsed.topics : Array.isArray(parsed) ? parsed : [];
    let items = raw.map(t => ({
        title: cleanLine(withoutSourceRefs(typeof t === 'string' ? t : t?.title, src), 200),
        description: String(withoutSourceRefs(t?.description ?? '', src)).trim().slice(0, 2000),
        sections: sectionRefs(t?.sections, src),
    })).filter(t => t.title);
    if (proposed.length) {
        // The assistant's titles are the ones the learner said yes to; the
        // model's answer gives their Overviews and parts, matched by title,
        // else by position.
        const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
        items = proposed.map((p, i) => {
            const match = items.find(t => norm(t.title) === norm(p)) || items[i] || null;
            return { title: p, description: match?.description || '', sections: match?.sections || [] };
        });
    }
    items = items.slice(0, SHORT.maxTopics);
    if (hasSources(src)) {
        // A topic that cites nothing is given the parts at its place in the
        // reading order, so its lesson is still taught from the source.
        const ids = src.sections.map(s => s.id);
        items.forEach((t, i) => {
            if (t.sections.length) return;
            const a = Math.floor((i * ids.length) / items.length);
            const b = Math.max(a + 1, Math.floor(((i + 1) * ids.length) / items.length));
            t.sections = ids.slice(a, b);
        });
    }
    return items;
}

function writeCourse({ projectId, items, parsed, keepName, src, documentIdOf, answered }) {
    const provenance = aiProvenance({ job: 'courses', answered });
    const insertNode = db.prepare(`INSERT INTO nodes (project_id, parent_id, title, description, notes, status, is_note, position, generated_by)
        VALUES (?, NULL, ?, ?, '', 'not_started', 0, ?, ?)`);
    const insertSource = db.prepare('INSERT INTO node_sources (node_id, document_id, page_from, page_to, char_from, char_to) VALUES (?, ?, ?, ?, ?, ?)');
    const name = cleanLine(parsed?.name, 200);
    const description = String(parsed?.description ?? '').trim().slice(0, 5000);
    db.transaction(() => {
        items.forEach((it, idx) => {
            const nodeId = insertNode.run(projectId, it.title, it.description, idx, provenance).lastInsertRowid;
            if (hasSources(src)) {
                for (const r of sourceRanges(src, it.sections, documentIdOf)) {
                    insertSource.run(nodeId, r.documentId, r.pageFrom, r.pageTo, r.charFrom, r.charTo);
                }
            }
        });
        const fields = [];
        const prev = db.prepare('SELECT generated_by, description FROM projects WHERE id = ?').get(projectId);
        if (name && !keepName) {
            db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(name, projectId);
            fields.push('name');
        }
        // Compare-and-set: a description the learner wrote while it was being
        // written stays theirs.
        if (description && !prev?.description) {
            db.prepare("UPDATE projects SET description = ? WHERE id = ? AND description = ''").run(description, projectId);
            fields.push('description');
        }
        const stamp = addProvenanceFields(prev?.generated_by, fields);
        if (stamp) db.prepare('UPDATE projects SET generated_by = ? WHERE id = ?').run(stamp, projectId);
    })();
    scheduleNodeSync();
    scheduleSearchWords();
}

/**
 * Write a short course again after its one call failed or was stopped (it
 * has no topics): from the documents it already holds, or from its topic.
 */
export function retryShortCourse(projectId, { origin = { surface: 'projects' } } = {}) {
    const p = db.prepare('SELECT id, name, made_from, ai_generating, content_language, learning_language FROM projects WHERE id = ?').get(Number(projectId) || 0);
    const madeFrom = parseJson(p?.made_from);
    if (!p || !madeFrom) throw new ShortCourseError(404, 'No such short course.');
    if (p.ai_generating || tasks.findActive({ kind: 'short_course', projectId: p.id })) throw new ShortCourseError(409, 'It is being written now.');
    if (db.prepare('SELECT 1 FROM nodes WHERE project_id = ? AND is_note = 0 LIMIT 1').get(p.id)) throw new ShortCourseError(409, 'It already has its topics.');
    if (!aiReady()) throw new ShortCourseError(409, 'No AI is connected.', { reason: 'no_ai' });
    const docs = db.prepare('SELECT id, title, content, file_type, original_filename, page_count FROM documents WHERE project_id = ? ORDER BY id').all(p.id);
    let src = null;
    let documentIdOf = () => null;
    if (madeFrom.kind !== 'topic') {
        if (!docs.length) throw new ShortCourseError(409, 'Its source is no longer in the course.');
        const rows = docs.map(d => {
            const map = buildSourceMap({ text: d.content, kind: d.file_type, filename: d.original_filename || d.title });
            if (!map.sections.length) {
                map.sections = partsOf(d.content, wordsOf(d.content));
                map.method = 'parts';
            }
            map.title = d.title;
            return { id: `doc:${d.id}`, title: d.title, file_type: d.file_type, content: d.content, page_count: d.page_count, map };
        });
        src = creationSources(rows);
        documentIdOf = (n) => docs[n - 1]?.id ?? null;
    }
    const lang = withLearning(getLanguage(p.content_language) || getLanguage('en'), getLanguage(p.learning_language));
    db.prepare('UPDATE projects SET ai_generating = 1 WHERE id = ?').run(p.id);
    const generated = parseJson(db.prepare('SELECT generated_by FROM projects WHERE id = ?').get(p.id)?.generated_by);
    const keepName = !(generated?.fields || []).includes('name');
    const title = madeFrom.kind === 'topic' ? madeFrom.title : (docs[0]?.title || p.name);
    const taskId = startBuild({
        projectId: p.id, name: p.name, keepName, title, proposed: [], src, documentIdOf,
        fromTopic: madeFrom.kind === 'topic', lang, origin,
        words: docs.reduce((n, d) => n + wordsOf(d.content), 0),
    });
    return { projectId: p.id, taskId };
}

// ---- the strip ------------------------------------------------------------------------

/**
 * Every short course for the strip on Projects: a course with a `made_from`
 * that is still one level (it leaves the strip when it grows a phase), not
 * archived. `state`: building | failed (no topics, not being written) |
 * ready | studying | finished.
 */
export function listShortCourses() {
    const rows = db.prepare(`
        SELECT p.id, p.name, p.icon, p.color, p.status, p.made_from, p.ai_generating, p.created_at,
          (SELECT COUNT(*) FROM nodes n WHERE n.project_id = p.id AND n.is_note = 0) AS topics,
          (SELECT COUNT(*) FROM nodes n WHERE n.project_id = p.id AND n.is_note = 0 AND n.status = 'completed') AS done,
          (SELECT COUNT(*) FROM nodes n WHERE n.project_id = p.id AND n.is_note = 0 AND n.status IN ('in_progress', 'completed')) AS started,
          EXISTS (SELECT 1 FROM nodes c JOIN nodes par ON par.id = c.parent_id
                  WHERE c.project_id = p.id AND c.is_note = 0 AND par.is_note = 0) AS deep
        FROM projects p
        WHERE p.made_from IS NOT NULL AND p.status != 'archived'
        ORDER BY p.id DESC`).all();
    const out = [];
    for (const r of rows) {
        if (r.deep) continue;
        const from = parseJson(r.made_from) || {};
        const task = tasks.findActive({ kind: 'short_course', projectId: r.id });
        const state = r.ai_generating || task ? 'building'
            : !r.topics ? 'failed'
                : r.status === 'completed' || r.done >= r.topics ? 'finished'
                    : r.started ? 'studying' : 'ready';
        out.push({
            id: r.id,
            name: r.name,
            icon: r.icon,
            color: r.color,
            kind: from.kind || 'file',
            from: from.kind === 'topic' ? null : (from.host || from.file || null),
            url: from.url || null,
            minutes: from.minutes || null,
            topics: r.topics,
            done: r.done,
            state,
            taskId: task?.id || null,
        });
    }
    return out;
}

/** Drop a source Read staged and the learner did not use. */
export function discardSource(stagedId) {
    return discardStaged(stagedId);
}
