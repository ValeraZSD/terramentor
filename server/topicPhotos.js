// Real photos for topics learned BY SIGHT (buildings, species, artworks):
// the app finds them in Wikimedia Commons, keeps only freely licensed ones,
// stores them in the library and credits each one.
//
// ## Why Commons, and only Commons
//
// - Every file there is under a free licence or in the public domain, and the
//   licence, author and source page are machine-readable per file
//   (`extmetadata`), so the credit line is the archive's own record, never a
//   model's guess.
// - It needs no key and no account: nothing about the learner is sent, only
//   the name of the thing searched for.
// - It holds the named examples a by-sight course needs (a named temple, a
//   species, a painting) under their own names.
// - Wikimedia asks reusers to download rather than hotlink, which is also what
//   makes a course work offline.
//
// ## The archive's rules this follows (Wikimedia's API etiquette and robot
// policy): an identifying User-Agent with a contact URL, one request at a
// time, at least a second apart, `maxlag` on the API (this is background
// work), a 429 or a lag answer honoured with its Retry-After and never retried
// more than once, and only a standard thumbnail width (960) from the upload
// host, so no new thumbnail is rendered for us.
//
// ## What reaches the learner
//
// A model names the EXAMPLES and what each shows; the archive's search finds
// candidates; the licence and shape filters below drop the rest; a model picks
// among what is left by number; with a model that sees images, it looks at the
// downloaded photo before it is kept. A lesson places a photo by NUMBER
// (`[[photo:N]]`, ai.js `lessonPhotoBlock`), which this file turns into the
// photo's id; no address a model wrote is ever fetched or shown.

import db from './database.js';
import { AI_PROMPTS, aiProvenance, getAISettings, transcribeImageToText, visionAvailability } from './ai.js';
import { firstChoice } from './aiJobs.js';
import { parseCreationJson } from './agentic.js';
import { structureCall } from './creationCalls.js';
import { safeFetch } from './netSafety.js';
import { boundedResponse, readCappedJson } from './httpBody.js';
import { makeThrottledQueue } from './searchBackends.js';
import { mediaStorage, sha256 } from './vaultStorage.js';
import { sniffMediaType } from './ankiMedia.js';
import { appVersion, REPO_URL } from './version.js';
import { failureFacts, logActivity } from './activityLog.js';
import * as tasks from './tasks.js';
import { getSetting } from './settingsStore.js';
import { getProjectLanguage } from './language.js';
import { WORK_LEAF } from './today.js';

// Every statement compiled once: some run per topic, per photo and per lesson.
const statements = new Map();
const stmt = (sql) => {
    if (!statements.has(sql)) statements.set(sql, db.prepare(sql));
    return statements.get(sql);
};

export const PHOTO_SETTING = 'creation_find_photos';
export const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const API_HOST = 'commons.wikimedia.org';
/** Where the archive serves a file: its thumbnails moved from the upload host
 *  to their own host (Nov 2026), and either may answer or redirect. */
const FILE_HOSTS = new Set(['upload.wikimedia.org', 'thumb.wikimedia.org']);
/** One of the thumbnail widths Wikimedia keeps rendered; any other width is
 *  a new rendering on their servers and is answered 429. */
export const PHOTO_WIDTH = 960;
/** At most this many topics of one course get photos, and this many examples
 *  each: the bound on requests to the archive and on calls to the model. */
export const MAX_SIGHT_TOPICS = 12;
export const MAX_EXAMPLES = 4;
const SEARCH_RESULTS = 8;
const CANDIDATES_SHOWN = 6;
const PICKS_PER_EXAMPLE = 2;
/** Photos a model looks at in one run, when the connection sees images. */
const MAX_VISION_CHECKS = 24;
const API_BODY_BYTES = 2 * 1024 * 1024;
const PHOTO_BYTES = 4 * 1024 * 1024;
const REQUEST_GAP_MS = 1000;
/** One request to the archive, answer included; a stalled socket would hold
 *  every course's photo run behind it. */
const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_AFTER_CAP_S = 120;
const MIN_WIDTH = 640;
const MIN_HEIGHT = 400;
/** Width / height. A thin panorama or a tall strip shows the subject too small
 *  to learn from at the size a lesson draws it. */
const MIN_RATIO = 0.6;
const MAX_RATIO = 2.0;
const PHOTO_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

// ---------------------------------------------------------------------------
// Licences and credit
// ---------------------------------------------------------------------------

/** HTML from the archive's metadata as one plain line. */
export function plainText(html, max = 300) {
    return String(html ?? '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
        .replace(/&#(\d+);/g, (_, n) => { const c = Number(n); return c > 31 && c < 0x110000 ? String.fromCodePoint(c) : ' '; })
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

const metaValue = (meta, key) => plainText(meta?.[key]?.value, 400);

/** A licence's deed, kept only on creativecommons.org: a credit link labelled
 *  with a licence opens that licence, never another site. */
export function licenceLink(raw) {
    try {
        const u = new URL(String(raw ?? '').trim().replace(/^http:/, 'https:'));
        if (u.protocol !== 'https:' || u.username || u.password || u.host !== 'creativecommons.org') return null;
        return u.toString().slice(0, 300);
    } catch { return null; }
}

/**
 * The licence a file may be used under here, or null. Kept: CC0, public
 * domain, CC BY and CC BY-SA (any version, ported or not). Dropped: anything
 * non-commercial or no-derivatives, GFDL-only (it asks for its whole text to
 * travel with the copy), fair use, and anything the archive marks non-free or
 * restricted (personality rights, trademarks, insignia): a learning app is
 * not the place to decide those are fine.
 */
export function licenceOf(meta) {
    if (!meta || typeof meta !== 'object') return null;
    if (/^true$/i.test(metaValue(meta, 'NonFree'))) return null;
    if (metaValue(meta, 'Restrictions')) return null;
    const code = metaValue(meta, 'License').toLowerCase();
    const short = metaValue(meta, 'LicenseShortName');
    if (/\b(nc|nd)\b/i.test(`${code} ${short}`.replace(/-/g, ' '))) return null;
    let kind = null;
    if (code === 'cc0' || /^cc0\b/i.test(short)) kind = 'cc0';
    else if (code === 'pd' || code.startsWith('pd-') || /^public domain\b/i.test(short)) kind = 'pd';
    else if (/^cc-by-sa-\d(\.\d)?(-[a-z]{2,3})?$/.test(code) || /^cc by-sa \d(\.\d)?\b/i.test(short)) kind = 'by-sa';
    else if (/^cc-by-\d(\.\d)?(-[a-z]{2,3})?$/.test(code) || /^cc by \d(\.\d)?\b/i.test(short)) kind = 'by';
    if (!kind) return null;
    // With no short name, one is built from the code in the form the course
    // file importer accepts ("CC BY-SA 4.0"), so the photo survives a round trip.
    const fromCode = () => code.replace(/-[a-z]{2,3}$/, '').replace(/^cc-by-sa-/, 'CC BY-SA ').replace(/^cc-by-/, 'CC BY ');
    return {
        kind,
        name: short || (kind === 'cc0' ? 'CC0' : kind === 'pd' ? 'Public domain' : fromCode()),
        url: licenceLink(metaValue(meta, 'LicenseUrl')),
    };
}

/** Who to credit: the archive's own attribution text when the file asks for
 *  one, else its author. A CC BY file with neither is not kept. */
export function authorOf(meta) {
    return (metaValue(meta, 'Attribution') || metaValue(meta, 'Artist')).slice(0, 200) || null;
}

const httpsOn = (raw, hosts) => {
    try {
        const u = new URL(String(raw).replace(/^\/\//, 'https://'));
        // `host`, not `hostname`: an address with a port of its own is not
        // the archive's.
        if (u.protocol !== 'https:' || u.username || u.password
            || !(typeof hosts === 'string' ? u.host === hosts : hosts.has(u.host))) return null;
        // The archive tags its addresses with campaign parameters; the file
        // is the same without them, and the request carries less.
        for (const k of [...u.searchParams.keys()]) if (/^utm_/i.test(k)) u.searchParams.delete(k);
        return u.toString();
    } catch { return null; }
};

/**
 * One search result as a candidate, or null with nothing kept: the licence,
 * author, type, size and shape rules, and both addresses on the archive's own
 * hosts. Exported for the gate.
 */
export function candidateOf(page) {
    const ii = page?.imageinfo?.[0];
    const title = String(page?.title || '');
    if (!ii || !title.startsWith('File:')) return null;
    if (!PHOTO_MIMES.has(ii.mime)) return null;
    const w = Number(ii.width), h = Number(ii.height);
    if (!(w >= MIN_WIDTH && h >= MIN_HEIGHT)) return null;
    const ratio = w / h;
    if (ratio < MIN_RATIO || ratio > MAX_RATIO) return null;
    const meta = ii.extmetadata || {};
    const licence = licenceOf(meta);
    if (!licence) return null;
    const author = authorOf(meta);
    if (!author && (licence.kind === 'by' || licence.kind === 'by-sa')) return null;
    const thumb = httpsOn(ii.thumburl || ii.url, FILE_HOSTS);
    if (!thumb) return null;
    const source = httpsOn(ii.descriptionurl, API_HOST)
        || `https://${API_HOST}/wiki/${encodeURIComponent(title.replace(/ /g, '_')).replace(/^File%3A/i, 'File:')}`;
    return {
        title: title.slice(0, 300),
        thumb,
        source,
        width: Number(ii.thumbwidth) || Math.min(w, PHOTO_WIDTH),
        height: Number(ii.thumbheight) || Math.round(Math.min(w, PHOTO_WIDTH) / ratio),
        licence,
        author,
        description: metaValue(meta, 'ImageDescription').slice(0, 160),
        categories: metaValue(meta, 'Categories').split('|').map(s => s.trim()).filter(Boolean).slice(0, 6),
        order: Number(page.index) || 0,
    };
}

/** How a candidate is shown to the model that picks: words only. */
const candidateLabel = (c) => {
    const name = c.title.replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, '').replace(/_/g, ' ');
    const bits = [name];
    if (c.description) bits.push(`description: ${c.description}`);
    if (c.categories.length) bits.push(`categories: ${c.categories.join('; ')}`);
    bits.push(`${c.width}x${c.height}`);
    return bits.join(' | ').slice(0, 420);
};

// ---------------------------------------------------------------------------
// Talking to the archive
// ---------------------------------------------------------------------------

/** Wikimedia refuses generic agents; this one names the app and where to
 *  reach its maintainers, and nothing about the person using it. */
export function commonsUserAgent() {
    let version = '0';
    try { version = appVersion().version || '0'; } catch { }
    return `Terramentor/${version} (${REPO_URL}; photo search for course topics) Node.js/${process.versions.node}`;
}

let fetchImpl = safeFetch;
let queue = makeThrottledQueue(REQUEST_GAP_MS);
let waitFor = (ms, signal) => new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason || new Error('Cancelled')); }, { once: true });
});

/** For the gate: answer the archive's requests from a stub, with no gap. */
export function setPhotoFetchForTest(fn, { gapMs = 0 } = {}) {
    fetchImpl = fn || safeFetch;
    queue = makeThrottledQueue(fn ? gapMs : REQUEST_GAP_MS);
    waitFor = fn ? (() => Promise.resolve()) : waitFor;
}

class ArchiveBusy extends Error {
    constructor(msg) { super(msg); this.name = 'ArchiveBusy'; }
}

const onArchive = (next) => next.protocol === 'https:' && (next.host === API_HOST || FILE_HOSTS.has(next.host));

/**
 * One request, in the queue. A 429, a 503 or a lag answer is waited out once
 * for its Retry-After; a second one stops the run (`ArchiveBusy`), so the app
 * never hammers a server that asked it to slow down.
 */
async function archiveRequest(url, { signal, read, stats }) {
    for (let attempt = 0; attempt < 2; attempt++) {
        const out = await queue(async () => {
            if (signal?.aborted) throw signal.reason || Object.assign(new Error('Cancelled'), { name: 'AbortError' });
            stats.requests++;
            const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
            const res = await fetchImpl(url, {
                headers: { 'User-Agent': commonsUserAgent(), 'Api-User-Agent': commonsUserAgent(), Accept: read === 'json' ? 'application/json' : 'image/*' },
                allowRedirect: onArchive,
                signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
            });
            const retryAfter = Math.min(Math.max(Number(res.headers.get('retry-after')) || 5, 1), RETRY_AFTER_CAP_S);
            if (res.status === 429 || res.status === 503) {
                await res.body?.cancel?.().catch(() => { });
                return { busy: retryAfter, status: res.status };
            }
            if (!res.ok) {
                await res.body?.cancel?.().catch(() => { });
                throw Object.assign(new Error(`the photo archive answered ${res.status}`), { status: res.status });
            }
            if (read === 'json') {
                const json = await readCappedJson(res, API_BODY_BYTES);
                if (json?.error?.code === 'maxlag') return { busy: retryAfter, status: 'maxlag' };
                if (json?.error) throw new Error(`the photo archive refused the search (${plainText(json.error.code, 40)})`);
                return { json };
            }
            const len = Number(res.headers.get('content-length'));
            if (len > PHOTO_BYTES) {
                await res.body?.cancel?.().catch(() => { });
                throw new Error('the photo is larger than the app keeps');
            }
            // Bounded while it streams: a body with no length is cut off at
            // the cap instead of being read whole first.
            const buf = Buffer.from(await boundedResponse(res, { bodyBytes: PHOTO_BYTES }).arrayBuffer());
            if (buf.length > PHOTO_BYTES) throw new Error('the photo is larger than the app keeps');
            return { buf };
        });
        if (!out.busy) return out;
        stats.waited++;
        if (attempt === 1) throw new ArchiveBusy(`the photo archive asked to slow down (${out.status})`);
        await waitFor(out.busy * 1000, signal);
    }
    throw new ArchiveBusy('the photo archive asked to slow down');
}

/** The archive's photos for one search, filtered; best search match first. */
export async function searchCommons(search, { signal, stats }) {
    const url = new URL(COMMONS_API);
    const params = {
        action: 'query', format: 'json', formatversion: '2', maxlag: '5',
        generator: 'search', gsrsearch: `${search} filetype:bitmap`, gsrnamespace: '6', gsrlimit: String(SEARCH_RESULTS),
        prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: String(PHOTO_WIDTH),
        iiextmetadatafilter: 'LicenseShortName|License|LicenseUrl|Artist|Attribution|NonFree|Restrictions|ImageDescription|Categories',
        iiextmetadatalanguage: 'en',
    };
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const { json } = await archiveRequest(url.toString(), { signal, read: 'json', stats });
    const pages = Array.isArray(json?.query?.pages) ? json.query.pages : [];
    return pages.map(candidateOf).filter(Boolean).sort((a, b) => a.order - b.order).slice(0, CANDIDATES_SHOWN);
}

async function downloadPhoto(candidate, { signal, stats }) {
    const { buf } = await archiveRequest(candidate.thumb, { signal, read: 'bytes', stats });
    const type = sniffMediaType(buf);
    if (!type || !PHOTO_MIMES.has(type.mime)) throw new Error('the archive sent something that is not a photo');
    return { buf, type };
}

// ---------------------------------------------------------------------------
// The model's part
// ---------------------------------------------------------------------------

const cleanLine = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
/** A model's words about an example, without any address in them: a name is
 *  shown and searched for, never followed. */
const modelLine = (s, n) => cleanLine(String(s ?? '').replace(/\b(?:https?|ftp|data|file):\S*/gi, ' ').replace(/\bwww\.\S+/gi, ' '), n);

/**
 * Which topics are learned by sight, and their examples, from one call.
 * Returns `[{ nodeId, examples: [{ name, search, shows }] }]`, only for the
 * topics given, at most MAX_SIGHT_TOPICS of them.
 */
export async function planPhotos(project, topics, { signal, answered } = {}) {
    if (!topics.length) return [];
    const prompt = AI_PROMPTS.photo_plan(project.name, project.description || '', topics,
        { lang: getProjectLanguage(project.id) });
    const raw = await structureCall(prompt, { signal, label: 'photo plan', answered });
    const parsed = parseCreationJson(raw);
    const list = Array.isArray(parsed?.topics) ? parsed.topics : [];
    const seen = new Set();
    const out = [];
    for (const t of list) {
        const idx = Number(t?.topic);
        if (!Number.isInteger(idx) || idx < 1 || idx > topics.length || seen.has(idx)) continue;
        const examples = [];
        const names = new Set();
        for (const e of Array.isArray(t.examples) ? t.examples : []) {
            const name = modelLine(e?.name, 160);
            const search = modelLine(e?.search, 160).replace(/["*|<>\[\]{}]/g, ' ').replace(/\s+/g, ' ').trim();
            if (!name || !search || names.has(search.toLowerCase())) continue;
            names.add(search.toLowerCase());
            examples.push({ name, search, shows: modelLine(e?.shows, 300) });
            if (examples.length >= MAX_EXAMPLES) break;
        }
        if (!examples.length) continue;
        seen.add(idx);
        out.push({ nodeId: topics[idx - 1].id, examples });
        if (out.length >= MAX_SIGHT_TOPICS) break;
    }
    return out;
}

/** For each example, the candidates the model picked, best first, by number. */
export async function choosePhotos(topicTitle, examples, { signal, answered } = {}) {
    const prompt = AI_PROMPTS.photo_choice(topicTitle, examples.map(e => ({
        subject: e.subject, shows: e.shows, candidates: e.candidates.map(c => ({ label: candidateLabel(c) })),
    })));
    const raw = await structureCall(prompt, { signal, label: 'photo choice', answered });
    const parsed = parseCreationJson(raw);
    const picks = examples.map(() => []);
    for (const p of Array.isArray(parsed?.picks) ? parsed.picks : []) {
        const e = Number(p?.example);
        if (!Number.isInteger(e) || e < 1 || e > examples.length) continue;
        for (const c of Array.isArray(p.candidates) ? p.candidates : []) {
            const k = Number(c);
            if (!Number.isInteger(k) || k < 1 || k > examples[e - 1].candidates.length) continue;
            if (!picks[e - 1].includes(k - 1)) picks[e - 1].push(k - 1);
            if (picks[e - 1].length >= PICKS_PER_EXAMPLE) break;
        }
    }
    return picks;
}

/** True only when the vision job's model is known to see images ('yes').
 *  'listed' is for work the learner starts (ai.js): this run is unattended, so
 *  a catalogue entry alone never sends photos to a billed model. A model that
 *  only might see would also invent what it was shown. */
async function visionReady() {
    try {
        const head = firstChoice('vision');
        if (!head?.enabled || !head.model) return false;
        const cap = await visionAvailability(head.model, head);
        return cap === 'yes';
    } catch { return false; }
}

/** Does the photo show the example? `{ ok, by }`; a failed look is `ok: null`
 *  (unchecked, kept as the archive and the picker chose it). */
async function lookAtPhoto(buf, mime, row, { signal }) {
    const answered = {};
    try {
        const prompt = `Is this a photograph of ${cleanLine(row.subject, 160)}${row.shows ? `, showing ${cleanLine(row.shows, 240)}` : ''}? `
            + 'Answer "no" for a drawing, map, plan, model, postcard, a different building or thing, or a photo where it is too small or hidden to learn its look from. '
            + 'Output ONLY a JSON object: {"ok": true} or {"ok": false}.';
        const text = await transcribeImageToText(buf, { prompt, mime, timeout: 60_000, signal, answered });
        const m = String(text || '').match(/"ok"\s*:\s*(true|false)/i);
        if (!m) return { ok: null, by: null };
        return { ok: m[1].toLowerCase() === 'true', by: aiProvenance({ job: 'vision', answered }) };
    } catch (err) {
        if (err?.name === 'AbortError') throw err;
        return { ok: null, by: null };
    }
}

// ---------------------------------------------------------------------------
// The library's part
// ---------------------------------------------------------------------------

const fileNameFor = (candidate, ext) => {
    const base = candidate.title.replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, '')
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, '_').slice(0, 120) || 'photo';
    return `${base}.${ext}`;
};

function keepPhoto(projectId, row, candidate, buf, type, checkedBy) {
    const { hash, size } = mediaStorage.put(buf);
    stmt(`INSERT OR IGNORE INTO media_files (project_id, hash, filename, mime, kind, size)
        VALUES (?, ?, ?, ?, 'image', ?)`).run(projectId, hash, fileNameFor(candidate, type.ext), type.mime, size);
    stmt(`UPDATE node_photos SET status = 'found', hash = ?, width = ?, height = ?, file_title = ?,
            author = ?, licence = ?, licence_url = ?, source_url = ?, checked_by = ?
        WHERE id = ?`).run(hash, candidate.width, candidate.height, candidate.title, candidate.author,
        candidate.licence.name, candidate.licence.url, candidate.source, checkedBy, row.id);
    // The file carries the course's words for it (the same text the screen
    // uses as its alt), so a screen reader has it and the describe-pictures
    // sweep does not send the photo to a model as an undescribed card picture.
    const alt = (row.shows ? `${row.subject}. ${row.shows}` : row.subject).slice(0, 1000);
    // The model that wrote it is named, as on every AI-written row.
    stmt(`UPDATE media_files SET description = ?, described_by = 'author', generated_by = ?
        WHERE project_id = ? AND hash = ? AND (description IS NULL OR description = '')`).run(alt, row.generated_by ?? null, projectId, hash);
}

const rowsOf = (nodeId) => stmt('SELECT * FROM node_photos WHERE node_id = ? ORDER BY position, id').all(nodeId);

// ---------------------------------------------------------------------------
// A run: one course, or one topic again
// ---------------------------------------------------------------------------

/** Runs in progress, by project: `{ controller, nodes: Set<nodeId> }`. */
const running = new Map();
let chain = Promise.resolve();

export const photosRunning = (projectId) => running.has(Number(projectId));
const nodeRunning = (nodeId, projectId) => !!running.get(Number(projectId))?.nodes.has(Number(nodeId));

/** The course's topics, in the order it is studied. */
function topicsInOrder(projectId) {
    return stmt(`
        WITH RECURSIVE ordered AS (
            SELECT id, printf('%08d-%010d', COALESCE(position, 0), id) AS path
            FROM live_nodes nodes WHERE project_id = ? AND parent_id IS NULL
            UNION ALL
            SELECT c.id, o.path || '/' || printf('%08d-%010d', COALESCE(c.position, 0), c.id)
            FROM live_nodes c JOIN ordered o ON c.parent_id = o.id
        )
        SELECT n.id, n.title, n.description
        FROM ordered o JOIN live_nodes n ON n.id = o.id
        WHERE ${WORK_LEAF}
        ORDER BY o.path
        LIMIT 60
    `).all(projectId);
}

/** Search, pick, look and keep, for one topic's pending examples. */
async function findForTopic(projectId, node, run) {
    const rows = rowsOf(node.id).filter(r => r.status === 'pending');
    if (!rows.length) return;
    const examples = [];
    for (const r of rows) {
        let candidates = [];
        try { candidates = await searchCommons(r.search || r.subject, run); }
        catch (err) { if (err instanceof ArchiveBusy || err?.name === 'AbortError') throw err; run.stats.failed++; }
        examples.push({ row: r, subject: r.subject, shows: r.shows, candidates });
    }
    const withCandidates = examples.filter(e => e.candidates.length);
    let picks = examples.map(() => []);
    if (withCandidates.length) {
        const chosen = await choosePhotos(node.title, withCandidates, { signal: run.signal });
        withCandidates.forEach((e, i) => { picks[examples.indexOf(e)] = chosen[i]; });
    }
    const usedHashes = new Set(stmt(`SELECT hash FROM node_photos WHERE node_id = ? AND hash IS NOT NULL`).all(node.id).map(r => r.hash));
    for (let i = 0; i < examples.length; i++) {
        const { row, candidates } = examples[i];
        let kept = false;
        for (const k of picks[i]) {
            const candidate = candidates[k];
            let photo;
            try { photo = await downloadPhoto(candidate, run); }
            catch (err) { if (err instanceof ArchiveBusy || err?.name === 'AbortError') throw err; run.stats.failed++; continue; }
            if (usedHashes.has(sha256(photo.buf))) continue;
            let checkedBy = null;
            if (run.vision && run.stats.looked < MAX_VISION_CHECKS) {
                run.stats.looked++;
                const look = await lookAtPhoto(photo.buf, photo.type.mime, row, { signal: run.signal });
                if (look.ok === false) { run.stats.refusedByLook++; continue; }
                if (look.ok === true) checkedBy = look.by;
            }
            keepPhoto(projectId, row, candidate, photo.buf, photo.type, checkedBy);
            usedHashes.add(sha256(photo.buf));
            kept = true;
            run.stats.found++;
            break;
        }
        if (!kept) {
            stmt(`UPDATE node_photos SET status = 'none' WHERE id = ? AND status = 'pending'`).run(row.id);
            run.stats.none++;
        }
    }
}

/**
 * Find photos for a course (`nodeIds` null) or again for some of its topics.
 * A course run asks the model which topics are learned by sight first; a topic
 * run re-searches the examples it already has. Resolves with the run's
 * numbers; never throws (a failure is logged and leaves no row pending).
 */
async function runPhotos(projectId, { nodeIds = null, controller, handle } = {}) {
    const started = performance.now();
    const project = stmt('SELECT id, name, description FROM live_projects projects WHERE id = ?').get(projectId);
    const run = {
        signal: controller.signal,
        stats: { requests: 0, waited: 0, failed: 0, found: 0, none: 0, looked: 0, refusedByLook: 0 },
        vision: false,
    };
    const state = running.get(projectId);
    let topics = 0;
    let outcome = 'done';
    let reason = null;
    try {
        if (!project) return run.stats;
        run.vision = await visionReady();
        let nodes;
        if (nodeIds) {
            // startPhotos already marked these topics pending.
            nodes = nodeIds.map(id => stmt('SELECT id, title, description FROM live_nodes nodes WHERE id = ? AND project_id = ?').get(id, projectId)).filter(Boolean);
        } else {
            // Topics that already have examples keep them (a course continued
            // after a stop); the rest are asked about.
            const all = topicsInOrder(projectId)
                .filter(n => !stmt('SELECT 1 FROM node_photos WHERE node_id = ? LIMIT 1').get(n.id));
            const answered = {};
            const plan = all.length ? await planPhotos(project, all, { signal: run.signal, answered }) : [];
            const by = aiProvenance({ job: 'courses', answered });
            const insert = stmt(`INSERT INTO node_photos (node_id, position, subject, search, shows, status, generated_by)
                VALUES (?, ?, ?, ?, ?, 'pending', ?)`);
            db.transaction(() => {
                for (const p of plan) {
                    p.examples.forEach((e, i) => insert.run(p.nodeId, i, e.name, e.search, e.shows, by));
                }
            })();
            if (state) state.planned = true;
            const planned = new Set(plan.map(p => p.nodeId));
            nodes = all.filter(n => planned.has(n.id));
        }
        topics = nodes.length;
        for (const n of nodes) state?.nodes.add(n.id);
        let done = 0;
        for (const n of nodes) {
            if (run.signal.aborted) break;
            try {
                await findForTopic(projectId, n, run);
            } catch (err) {
                if (err instanceof ArchiveBusy) { outcome = 'busy'; reason = err.message; break; }
                if (err?.name === 'AbortError' || run.signal.aborted) break;
                run.stats.failed++;
            } finally {
                state?.nodes.delete(n.id);
            }
            done++;
            const pct = Math.round((done / nodes.length) * 100);
            handle?.update({ progress: pct, percent: pct, message: `${run.stats.found} photos found` });
            await new Promise(r => setImmediate(r));
        }
        if (run.signal.aborted) outcome = 'cancelled';
    } catch (err) {
        outcome = err?.name === 'AbortError' || run.signal.aborted ? 'cancelled' : 'failed';
        if (outcome === 'failed') {
            reason = err?.message || 'Finding photos failed';
            logActivity({ area: 'project', event: 'photos.failed', level: 'warn', detail: failureFacts(err), projectId });
        }
    } finally {
        // Nothing is left waiting: what a stopped run did not reach is "none",
        // and the topic page offers to look again.
        stmt(`UPDATE node_photos SET status = 'none'
            WHERE status = 'pending' AND node_id IN (SELECT id FROM nodes WHERE project_id = ?)`).run(projectId);
    }
    const s = run.stats;
    logActivity({
        area: 'project', event: `photos.${outcome}`, level: outcome === 'done' || outcome === 'cancelled' ? 'info' : 'warn',
        detail: `${topics} topics · ${s.found} found · ${s.none} none · ${s.requests} requests${s.waited ? ` · ${s.waited} waits` : ''}${s.looked ? ` · ${s.looked} looked at` : ''}`,
        ms: performance.now() - started, projectId,
    });
    return { outcome, reason, topics, ...s };
}

/**
 * Start finding photos in the background. Returns `{ started }`; a project
 * with a run already going gets `{ started: false }`. The run is a task the
 * learner sees and can stop; runs queue behind each other, because the
 * archive asks for one request at a time from each user.
 */
export function startPhotos(projectId, { nodeIds = null, origin } = {}) {
    projectId = Number(projectId);
    if (running.has(projectId)) return { started: false, reason: 'running' };
    if (!getAISettings().enabled) return { started: false, reason: 'ai_off' };
    const controller = new AbortController();
    const state = { controller, nodes: new Set(nodeIds || []), planned: !!nodeIds, done: null };
    // Registered first: if that throws, nothing is left marked as running, and
    // the course creation that called this still finishes.
    let handle;
    try {
        handle = tasks.registerExternal({
            kind: 'find_photos',
            label: 'Finding photos',
            labelKey: 'Finding photos',
            origin: origin || { surface: 'app', job: 'find_photos', projectId },
            projectId,
            cancel: () => controller.abort(Object.assign(new Error('Cancelled'), { name: 'AbortError' })),
        });
    } catch (err) {
        logActivity({ area: 'project', event: 'photos.failed', level: 'warn', detail: failureFacts(err), projectId });
        return { started: false, reason: 'failed' };
    }
    running.set(projectId, state);
    // Marked before the run starts, so the answer to "look again" already
    // says pending and the screen keeps checking until the run is over.
    if (nodeIds) {
        const mark = stmt(`UPDATE node_photos SET status = 'pending' WHERE node_id = ? AND status = 'none'
            AND node_id IN (SELECT id FROM nodes WHERE project_id = ?)`);
        for (const id of nodeIds) mark.run(id, projectId);
    }
    const p = chain.then(() => runPhotos(projectId, { nodeIds, controller, handle }))
        .then((result) => {
            // A run the archive stopped, or one that failed, says so in the
            // task list instead of reading as finished.
            if (result?.outcome === 'cancelled') { try { handle.cancelled?.(); } catch { } }
            else if (result?.outcome === 'failed' || result?.outcome === 'busy') { try { handle.fail(result.reason); } catch { } }
            else try { handle.finish(); } catch { }
            return result;
        })
        .catch((err) => { try { handle.fail(err.message); } catch { } })
        .finally(() => { running.delete(projectId); });
    state.done = p;
    chain = p.catch(() => { });
    return { started: true, done: p };
}

/** Is the setting on that lets course creation look for photos? (On by default.) */
export const photosWanted = () => getSetting(PHOTO_SETTING, 'true') !== 'false';

// ---------------------------------------------------------------------------
// Reading them back
// ---------------------------------------------------------------------------

/**
 * A topic's photo state: null when it is not learned by sight (no examples),
 * else 'pending' while a run still works on it, 'found' with at least one
 * photo, 'none' when it has none.
 */
export function photoState(nodeId, rows = null) {
    const list = rows || rowsOf(nodeId);
    if (!list.length) return null;
    if (list.some(r => r.status === 'found')) {
        return list.some(r => r.status === 'pending') && runningFor(nodeId) ? 'pending' : 'found';
    }
    return list.some(r => r.status === 'pending') && runningFor(nodeId) ? 'pending' : 'none';
}

const runningFor = (nodeId) => {
    const row = stmt('SELECT project_id FROM nodes WHERE id = ?').get(nodeId);
    return !!row && running.has(row.project_id);
};

/** What a screen shows for one photo: the stored file and the archive's credit. */
export function photoView(r) {
    return {
        uuid: r.uuid,
        hash: r.hash,
        subject: r.subject,
        shows: r.shows || '',
        width: r.width,
        height: r.height,
        author: r.author,
        licence: r.licence,
        licenceUrl: r.licence_url,
        sourceUrl: r.source_url,
        checked: !!r.checked_by,
    };
}

/** A topic's photos for a screen: `{ state, photos }`. */
export function topicPhotos(nodeId) {
    const rows = rowsOf(nodeId);
    return {
        state: photoState(nodeId, rows),
        photos: rows.filter(r => r.status === 'found' && r.hash).map(photoView),
    };
}

/** For the lesson writer: null (not by sight), [] (none to show) or the photos. */
export function lessonPhotos(nodeId) {
    const rows = rowsOf(nodeId);
    if (!rows.length) return null;
    return rows.filter(r => r.status === 'found' && r.hash);
}

/**
 * Wait, up to `timeoutMs`, while a run is still finding this topic's photos,
 * so a lesson opened right after creation is written with them. Returns
 * what `lessonPhotos` returns once it is settled or the wait is over.
 */
export async function awaitTopicPhotos(nodeId, { timeoutMs = 45_000, signal } = {}) {
    const row = stmt('SELECT project_id FROM nodes WHERE id = ?').get(nodeId);
    const until = Date.now() + timeoutMs;
    while (row && Date.now() < until && !signal?.aborted) {
        const state = running.get(row.project_id);
        if (!state) break;
        const rows = rowsOf(nodeId);
        // Planning has not reached this topic yet, or it is being searched.
        const pending = state.nodes.has(Number(nodeId)) || rows.some(r => r.status === 'pending')
            || (!rows.length && !state.planned);
        if (!pending) break;
        await new Promise(r => setTimeout(r, 400));
    }
    return lessonPhotos(nodeId);
}

// ---------------------------------------------------------------------------
// Markers in lesson text
// ---------------------------------------------------------------------------

const PHOTO_REF = /\[\[photo:(\d{1,2})\]\]/g;
/** A marker as the app stores it: the photo's uuid, on a line of its own. */
export const STORED_PHOTO_MARKER = /^\[\[photo:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]\]$/;
const MARKDOWN_IMAGE = /!\[[^\]\n]*\]\([^)\n]*\)/g;
const HTML_IMAGE = /<img\b[^>\n]*>/gi;

/**
 * Turn the writer's `[[photo:N]]` into the photo's id on a line of its own,
 * for the photos it was given (`photos`, numbered from 1). A number not on
 * the list, or used a second time, is dropped. For a topic learned by sight
 * any image the model wrote itself is dropped too: what it shows is a photo
 * from the archive, or nothing. Returns `{ text, placed: Set<uuid> }`.
 */
export function placePhotoMarkers(text, photos) {
    const placed = new Set();
    let out = String(text ?? '');
    if (Array.isArray(photos)) out = out.replace(MARKDOWN_IMAGE, '').replace(HTML_IMAGE, '');
    out = out.replace(PHOTO_REF, (_, n) => {
        const p = Array.isArray(photos) ? photos[Number(n) - 1] : null;
        if (!p?.uuid || placed.has(p.uuid)) return '';
        placed.add(p.uuid);
        return `\n\n[[photo:${p.uuid}]]\n\n`;
    });
    if (placed.size || Array.isArray(photos)) out = out.replace(/\n{3,}/g, '\n\n').trim();
    return { text: out, placed };
}

/** The uuids a stored part places, in order. */
export function placedPhotoIds(text) {
    return [...String(text ?? '').matchAll(/\[\[photo:([0-9a-f-]{36})\]\]/g)].map(m => m[1]);
}

/**
 * A lesson card's photos: the ones its text places (`photos`, drawn where
 * their markers stand) and, on one part of the topic, the ones no part
 * places (`photoStrip`, drawn after the text): on the first part while no
 * part places any, else on the last. A topic with no photos adds nothing.
 */
export function lessonPhotoFields(nodeId, content, { partIndex = 1, partCount = 1 } = {}) {
    const rows = rowsOf(nodeId).filter(r => r.status === 'found' && r.hash);
    if (!rows.length) return {};
    const views = new Map(rows.map(r => [r.uuid, photoView(r)]));
    const here = [...new Set(placedPhotoIds(content))].filter(u => views.has(u));
    const placedAnywhere = new Set(stmt(`SELECT content FROM feed_items WHERE node_id = ? AND kind = 'lesson'`)
        .all(nodeId).flatMap(r => placedPhotoIds(r.content)));
    const unplaced = rows.filter(r => !placedAnywhere.has(r.uuid)).map(r => views.get(r.uuid));
    const stripHere = placedAnywhere.size === 0 ? partIndex === 1 : partIndex === partCount;
    return {
        ...(here.length ? { photos: here.map(u => views.get(u)) } : {}),
        ...(stripHere && unplaced.length ? { photoStrip: unplaced } : {}),
    };
}

/**
 * A topic's photos as a course file carries them: every example with what it
 * shows, and for each photo found its credit (author, licence, source page)
 * and, in a bundle, the name of its file under `media/`. A plain JSON export
 * has no files, so it carries the credit and the examples only; the library
 * that imports it can look for them again.
 */
export function exportedPhotos(nodeId, names = null) {
    return rowsOf(nodeId).map((r) => {
        const out = { subject: r.subject, search: r.search || undefined, shows: r.shows || undefined };
        if (r.status === 'found' && r.hash) {
            Object.assign(out, {
                file_title: r.file_title || undefined,
                author: r.author || undefined,
                licence: r.licence || undefined,
                licence_url: r.licence_url || undefined,
                source_url: r.source_url || undefined,
                width: r.width || undefined,
                height: r.height || undefined,
                media: names?.get(r.hash) || undefined,
            });
        }
        Object.keys(out).forEach(k => { if (out[k] === undefined) delete out[k]; });
        return out;
    });
}
