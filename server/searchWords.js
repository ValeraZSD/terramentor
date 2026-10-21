// The words a course's search links put in front of a topic's title.
//
// A topic title is written for its place in ONE course, so "Watch on YouTube"
// searching it alone searches the whole world: "Alphabet" in a Dutch course
// finds every language's alphabet, "Ownership" in a Rust course finds property
// law, "Value and Light" in a drawing course finds anything. Appending the
// course's NAME was the old answer, and it fails the other way: a name is a
// sentence ("Нидерландский язык: с нуля до C1", "Learn Linux security from
// the ground up") that buries the topic. So each course gets a few words of
// its own, written once by the model from the course's name, goal and topic
// titles, and editable by the learner:
//
//   - NULL means not written yet; '' is an answer ("nothing to add", a course
//     that mixes unrelated subjects), and is never asked again.
//   - The learner's own words are stamped 'user' and no sweep touches them.
//   - Model-written words are cleared when the course's name or goal changes,
//     so they are written again for what the course now says it is.
//   - FAILURES ARE RECORDED per model (`search_words_tries`, the model in
//     `search_words_by`), three each, as `regionNaming.js` does: a model that
//     cannot do the job is not re-asked on every start, and a different model
//     gets a clean slate.
//   - Runs on the ONE shared background chain (`enqueueVectorJob`), behind
//     whatever else a single-slot local model is doing.
//   - Every answer is MECHANICALLY VALIDATED (`validateSearchWords`, pure,
//     asserted by `tools/search-words-gates.mjs`).
//
// The client half is `buildQuery` in src/utils/searchProviders.ts.

import db from './database.js';
import { generateResponse, getAISettings, AI_PROMPTS } from './ai.js';
import { enqueueVectorJob, isUnavailable } from './embeddings.js';
import { cleanRegionLabel } from './curriculumLabel.js';
import * as tasks from './tasks.js';

/** `search_words_by` for words the learner typed. */
export const USER_SOURCE = 'user';
/** Failures one model gets per course before only another model is asked. */
export const MAX_ATTEMPTS = 3;
const MAX_WORDS = 4;
const MAX_CHARS = 40;
/** The learner's own words get more room: they were deliberate. */
const USER_MAX_CHARS = 80;
/** Topic titles the model is shown, in course order. */
const TITLE_SAMPLE = 14;
const MAX_PER_SWEEP = 40;
const MAX_CONSECUTIVE_FAILURES = 3;
const SWEEP_DELAY_MS = 4000;

/** Words that say nothing about a subject: a search finds these anyway. */
const FILLER = new Set([
    'course', 'courses', 'tutorial', 'tutorials', 'lesson', 'lessons', 'video', 'videos',
    'beginner', 'beginners', 'basics', 'explained', 'learn', 'learning', 'guide',
    'introduction', 'intro', 'class', 'lecture', 'for', 'the', 'a', 'an', 'and', 'of',
]);

/** Not words at all: what a model writes for "nothing here". */
const PLACEHOLDERS = new Set([
    'undefined', 'null', 'nil', 'none', 'nan', 'n/a', 'na', 'nothing', 'empty',
    'unknown', 'words', 'string', 'todo', 'tbd', 'placeholder', 'error',
]);

/**
 * The model's raw reply → the string it meant, or null when no answer can be
 * read out of it. `{"words": ""}` is an answer, '' (nothing to add); an empty
 * or unparseable reply is not.
 */
export function readWordsReply(raw) {
    const text = String(raw ?? '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
    if (!text) return null;
    if (text.startsWith('{')) {
        try {
            const v = JSON.parse(text)?.words;
            if (typeof v === 'string') return v;
            return null;
        } catch { /* a fragment: the key below */ }
    }
    const keyed = text.match(/"words"\s*:\s*"([^"\n]{0,80})"/);
    if (keyed) return keyed[1];
    // A small local model answering with the bare words on one line.
    if (!/[{}]/.test(text) && !text.includes('\n')) return text;
    return null;
}

/**
 * Are these usable as a model's search words?
 * @returns {{ok: true, words: string} | {ok: false, reason: string}}
 */
export function validateSearchWords(raw) {
    if (typeof raw !== 'string') return { ok: false, reason: 'not-a-string' };
    const s = raw.trim()
        .replace(/^(?:words|search words|answer)\s*[:—-]\s*/i, '')
        .replace(/^["'“”‘’«»`]+|["'“”‘’«»`]+$/g, '')
        .replace(/[.。]+$/, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!s) return { ok: true, words: '' };
    if (s.length > MAX_CHARS) return { ok: false, reason: 'too-long' };
    if (s.split(' ').length > MAX_WORDS) return { ok: false, reason: 'too-many-words' };
    if (!/\p{L}/u.test(s)) return { ok: false, reason: 'no-letters' };
    // A sentence or a list, not a few words ("Node.js" and "C++" are words).
    if (/[!?;,:]|\.\s/.test(s)) return { ok: false, reason: 'sentence' };
    if (/[{}[\]<>|\\]/.test(s)) return { ok: false, reason: 'markup' };
    const lower = s.toLowerCase();
    if (PLACEHOLDERS.has(lower)) return { ok: false, reason: 'placeholder' };
    if (lower.split(' ').every(w => FILLER.has(w))) return { ok: false, reason: 'filler' };
    return { ok: true, words: s };
}

/** The learner's own words: '' (none) is allowed, only length and markup are refused. */
export function validateUserSearchWords(raw) {
    const s = String(raw ?? '').replace(/\s+/g, ' ').trim();
    if (s.length > USER_MAX_CHARS) return { ok: false, reason: 'too-long' };
    if (/[<>{}]/.test(s)) return { ok: false, reason: 'markup' };
    return { ok: true, words: s };
}

/** Which model writes the words: the chat model. */
function wordsModel() {
    return getAISettings().model || '';
}

function inboxId() {
    try {
        return Number(db.prepare("SELECT value FROM settings WHERE key = 'inbox_project_id'").get()?.value) || 0;
    } catch {
        return 0;
    }
}

const leafTitlesStmt = () => db.prepare(`
    SELECT n.title FROM nodes n
    WHERE n.project_id = ? AND COALESCE(n.is_note, 0) = 0
      AND NOT EXISTS (SELECT 1 FROM nodes c WHERE c.parent_id = n.id AND COALESCE(c.is_note, 0) = 0)
    ORDER BY n.id`);

/** The topic titles the model is shown: in course order, cleaned, deduped. */
export function titlesFor(projectId) {
    const seen = new Set();
    const out = [];
    for (const { title } of leafTitlesStmt().all(projectId)) {
        const t = cleanRegionLabel(String(title || '')).trim();
        const k = t.toLowerCase();
        if (!t || seen.has(k)) continue;
        seen.add(k);
        out.push(t);
        if (out.length >= TITLE_SAMPLE) break;
    }
    return out;
}

/**
 * Courses still waiting for words that this model has not given up on.
 * A course still being built is skipped: its topics are not there yet, and
 * its creation schedules a sweep when it finishes.
 */
export function pendingCourses(model, limit = MAX_PER_SWEEP) {
    return db.prepare(`
        SELECT id, name, description FROM projects
        WHERE search_words IS NULL
          AND COALESCE(ai_generating, 0) = 0
          AND id != ?
          AND NOT (COALESCE(search_words_tries, 0) >= ? AND search_words_by = ?)
          AND EXISTS (SELECT 1 FROM nodes WHERE project_id = projects.id AND COALESCE(is_note, 0) = 0)
        ORDER BY id LIMIT ?`).all(inboxId(), MAX_ATTEMPTS, model, limit);
}

/**
 * Ask for one course's words: `{words, reason}`, `words` null on any content
 * failure. Only an unavailable endpoint throws.
 */
export async function writeSearchWords(course, { model = null, signal } = {}) {
    const titles = titlesFor(course.id);
    if (titles.length === 0) return { words: null, reason: 'no-topics' };
    const { system, user } = AI_PROMPTS.search_words({ name: course.name, description: course.description, titles });
    let raw;
    try {
        raw = await generateResponse(user, system, [], {
            temperature: 0.2,
            operation: 'search_words',
            signal,
            model: model || undefined,
        });
    } catch (err) {
        if (isUnavailable(err)) throw err;
        return { words: null, reason: `call-failed: ${String(err?.message || err).slice(0, 120)}` };
    }
    const meant = readWordsReply(raw);
    if (meant === null) return { words: null, reason: 'unreadable' };
    const verdict = validateSearchWords(meant);
    return verdict.ok ? { words: verdict.words, reason: null } : { words: null, reason: verdict.reason };
}

function store(id, words, by) {
    // `IS NULL`: a learner's edit that landed while the model was thinking wins.
    db.prepare(`UPDATE projects SET search_words = ?, search_words_by = ?, search_words_tries = 0
                WHERE id = ? AND search_words IS NULL`).run(words, by, id);
}

function recordFailure(id, model) {
    db.prepare(`UPDATE projects SET
            search_words_tries = CASE WHEN search_words_by = ? THEN COALESCE(search_words_tries, 0) + 1 ELSE 1 END,
            search_words_by = ?
        WHERE id = ? AND search_words IS NULL`).run(model, model, id);
}

/** The learner's words. '' = none. */
export function setSearchWords(id, words) {
    db.prepare(`UPDATE projects SET search_words = ?, search_words_by = ?, search_words_tries = 0 WHERE id = ?`)
        .run(words, USER_SOURCE, id);
}

/**
 * The course's name or goal changed: words a MODEL wrote describe what the
 * course used to say it is, so they are written again. The learner's stay.
 */
export function clearModelSearchWords(id, { evenTheLearners = false } = {}) {
    const r = db.prepare(`UPDATE projects SET search_words = NULL, search_words_by = NULL, search_words_tries = 0
                          WHERE id = ? AND (? OR COALESCE(search_words_by, '') != ?)`).run(id, evenTheLearners ? 1 : 0, USER_SOURCE);
    return r.changes > 0;
}

/** Write words for every course that has none, on the shared background chain. */
export async function runSearchWordsSweep({ model = wordsModel() } = {}) {
    if (!getAISettings().enabled || !model) return 0;
    const pending = pendingCourses(model);
    if (pending.length === 0) return 0;
    const handle = tasks.registerExternal({
        kind: 'search_words',
        label: `Writing search words for ${pending.length} course${pending.length === 1 ? '' : 's'}`,
        labelKey: 'Writing search words for {{count}} courses',
        labelParams: { count: pending.length },
        origin: { surface: 'app', job: 'search_words' },
        cancel: () => { },
    });
    let written = 0;
    let unreachable = 0;
    try {
        for (let i = 0; i < pending.length; i++) {
            let result;
            try {
                result = await writeSearchWords(pending[i], { model });
                unreachable = 0;
            } catch (err) {
                // Unavailable is the endpoint's failure, not the course's: nothing
                // is recorded, and the batch ends after a few in a row.
                if (isUnavailable(err) && ++unreachable >= MAX_CONSECUTIVE_FAILURES) break;
                continue;
            }
            if (result.words !== null) {
                store(pending[i].id, result.words, model);
                written++;
            } else {
                recordFailure(pending[i].id, model);
            }
            const percent = Math.round(((i + 1) / pending.length) * 100);
            handle.update({ progress: percent, percent });
        }
        handle.finish();
    } catch (err) {
        handle.fail(err?.message);
    }
    return written;
}

let sweepTimer = null;

/** Debounced: a creation or an import asks once, after its writes settle. */
export function scheduleSearchWords({ delay = SWEEP_DELAY_MS } = {}) {
    if (sweepTimer) clearTimeout(sweepTimer);
    sweepTimer = setTimeout(() => {
        sweepTimer = null;
        enqueueVectorJob(() => runSearchWordsSweep());
    }, delay);
    sweepTimer.unref?.();
}
