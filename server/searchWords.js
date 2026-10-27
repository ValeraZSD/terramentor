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
//   - Model-written words are cleared when the course's name or goal changes
//     (`courseRenamed`, from the edit route and the assistant's edits), so
//     they are written again for what the course now says it is. An answer
//     that comes back after such a change is dropped: it was written for the
//     name the call was sent with (`store` compares it).
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
import { TOPIC_NODE } from './nodeRole.js';
import { userSearchWords } from './projectFields.js';
import * as tasks from './tasks.js';

/** `search_words_by` for words the learner typed. */
export const USER_SOURCE = 'user';
/** Failures one model gets per course before only another model is asked. */
export const MAX_ATTEMPTS = 3;
const MAX_WORDS = 4;
const MAX_CHARS = 40;
/** Topic titles the model is shown, in course order. */
const TITLE_SAMPLE = 14;
/** A title is one line of the prompt, never a block of its own. */
const TITLE_MAX_CHARS = 120;
const MAX_PER_SWEEP = 40;
const MAX_CONSECUTIVE_FAILURES = 3;
const SWEEP_DELAY_MS = 4000;

/**
 * Words that say nothing about a subject: a search finds these anyway. The
 * prompt asks for the titles' language, so the commonest of the app's
 * languages are here too; an answer made ONLY of these is refused.
 */
const FILLER = new Set([
    'course', 'courses', 'tutorial', 'tutorials', 'lesson', 'lessons', 'video', 'videos',
    'beginner', 'beginners', 'basics', 'explained', 'learn', 'learning', 'guide',
    'introduction', 'intro', 'class', 'lecture', 'for', 'the', 'a', 'an', 'and', 'of',
    'курс', 'курсы', 'урок', 'уроки', 'для', 'начинающих', 'основы', 'видео',
    'cursus', 'les', 'lessen', 'voor', 'kurs', 'für', 'anfänger', 'grundlagen',
    'cours', 'pour', 'débutants', 'curso', 'para', 'principiantes',
]);

/**
 * A word that makes an answer a refusal ("Not applicable", "No specific
 * subject", "I cannot determine"): a few words with no punctuation pass every
 * other check, and would then go in front of every search in the course.
 */
const REFUSAL = new Set([
    'not', 'no', 'cannot', "can't", 'unable', 'unclear', 'unknown', 'sorry', 'applicable', 'determine',
    'нет', 'не', 'невозможно', 'geen', 'niet', 'nicht', 'kein', 'keine', 'aucun', 'aucune', 'pas',
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
    // Invisible control and direction characters go first, as in the learner's words.
    const s = raw.replace(/\p{C}/gu, ' ').trim()
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
    const words = lower.split(' ');
    if (words.some(w => REFUSAL.has(w))) return { ok: false, reason: 'refusal' };
    if (words.every(w => FILLER.has(w))) return { ok: false, reason: 'filler' };
    return { ok: true, words: s };
}

/** The learner's own words: the rule lives with the other course fields, so a course file is held to it too. */
export const validateUserSearchWords = userSearchWords;

/** Which model writes the words: the chat model. */
function wordsModel() {
    return getAISettings().model || '';
}

/** Each statement prepared once, on first use (the sweep runs them per course). */
const prepared = new Map();
const stmt = (sql) => {
    let s = prepared.get(sql);
    if (!s) prepared.set(sql, s = db.prepare(sql));
    return s;
};

function inboxId() {
    try {
        return Number(stmt("SELECT value FROM settings WHERE key = 'inbox_project_id'").get()?.value) || 0;
    } catch {
        return 0;
    }
}

/**
 * A topic leaf of the course (alias `n`): a deck's "Stage 3" slices are
 * leaves too, and their titles say nothing about the subject.
 */
const TOPIC_LEAF = `COALESCE(n.is_note, 0) = 0 AND ${TOPIC_NODE}
      AND NOT EXISTS (SELECT 1 FROM nodes c WHERE c.parent_id = n.id AND COALESCE(c.is_note, 0) = 0)`;

/** The topic titles the model is shown: in course order, cleaned, deduped, one line each. */
export function titlesFor(projectId) {
    const seen = new Set();
    const out = [];
    const rows = stmt(`SELECT n.title FROM nodes n WHERE n.project_id = ? AND ${TOPIC_LEAF} ORDER BY n.id`).all(projectId);
    for (const { title } of rows) {
        const t = cleanRegionLabel(String(title || '')).replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX_CHARS);
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
    return stmt(`
        SELECT id, name, description FROM projects
        WHERE search_words IS NULL
          AND COALESCE(ai_generating, 0) = 0
          AND id != ?
          AND NOT (COALESCE(search_words_tries, 0) >= ? AND search_words_by = ?)
          AND EXISTS (SELECT 1 FROM nodes n WHERE n.project_id = projects.id AND ${TOPIC_LEAF})
        ORDER BY id LIMIT ?`).all(inboxId(), MAX_ATTEMPTS, model, limit);
}

/** The course as it is NOW: a sweep's list is minutes old by its last course. */
const courseNow = (id) => stmt('SELECT id, name, description, search_words FROM projects WHERE id = ?').get(id);

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

// Both writes land only on the course the call was ABOUT: `IS NULL` lets a
// learner's edit made while the model was thinking win, and the name and goal
// must still be the ones the prompt carried, or the answer describes a course
// that no longer exists (the rename has already scheduled the next sweep).
const SAME_COURSE = 'id = ? AND search_words IS NULL AND name IS ? AND description IS ?';

function store(course, words, by) {
    stmt(`UPDATE projects SET search_words = ?, search_words_by = ?, search_words_tries = 0 WHERE ${SAME_COURSE}`)
        .run(words, by, course.id, course.name, course.description);
}

function recordFailure(course, model) {
    stmt(`UPDATE projects SET
            search_words_tries = CASE WHEN search_words_by = ? THEN COALESCE(search_words_tries, 0) + 1 ELSE 1 END,
            search_words_by = ?
        WHERE ${SAME_COURSE}`).run(model, model, course.id, course.name, course.description);
}

/** What an export carries: the learner's own words ('' = none), never a model's. */
export function learnersSearchWords(project) {
    return project?.search_words_by === USER_SOURCE && project.search_words != null ? project.search_words : undefined;
}

/** The learner's words. '' = none. */
export function setSearchWords(id, words) {
    stmt('UPDATE projects SET search_words = ?, search_words_by = ?, search_words_tries = 0 WHERE id = ?')
        .run(words, USER_SOURCE, id);
}

/**
 * The course's name or goal changed: words a MODEL wrote were read off the
 * other name, so they are cleared to be written again. The learner's stay.
 */
export function clearModelSearchWords(id, { evenTheLearners = false } = {}) {
    const r = stmt(`UPDATE projects SET search_words = NULL, search_words_by = NULL, search_words_tries = 0
                    WHERE id = ? AND (? OR COALESCE(search_words_by, '') != ?)`).run(id, evenTheLearners ? 1 : 0, USER_SOURCE);
    return r.changes > 0;
}

/**
 * Every writer of a course's name or goal calls this after the write. Unless
 * the words are the learner's, the course is asked again, including when they
 * were still NULL: a call in flight for the old name has its answer dropped.
 */
export function courseRenamed(id) {
    if (clearModelSearchWords(id)) scheduleSearchWords();
}

/** Write words for every course that has none, on the shared background chain. */
export async function runSearchWordsSweep({ model = wordsModel() } = {}) {
    if (!getAISettings().enabled || !model) return 0;
    const pending = pendingCourses(model);
    if (pending.length === 0) return 0;
    const abort = new AbortController();
    const handle = tasks.registerExternal({
        kind: 'search_words',
        label: `Writing search words for ${pending.length} course${pending.length === 1 ? '' : 's'}`,
        labelKey: 'Writing search words for {{count}} courses',
        labelParams: { count: pending.length },
        origin: { surface: 'app', job: 'search_words' },
        cancel: () => abort.abort(),
    });
    let written = 0;
    let unreachable = 0;
    let lastError = null;
    try {
        for (let i = 0; i < pending.length && !abort.signal.aborted; i++) {
            const course = courseNow(pending[i].id);
            // Deleted, or given words (by the learner) since the list was read.
            if (!course || course.search_words !== null) continue;
            let result;
            try {
                result = await writeSearchWords(course, { model, signal: abort.signal });
                unreachable = 0;
            } catch (err) {
                // Unavailable is the endpoint's failure, not the course's: nothing
                // is recorded, and the batch ends after a few in a row.
                lastError = err;
                if (isUnavailable(err) && ++unreachable >= MAX_CONSECUTIVE_FAILURES) break;
                continue;
            }
            if (abort.signal.aborted) break;
            if (result.words !== null) {
                store(course, result.words, model);
                written++;
            } else if (result.reason !== 'no-topics') {
                // Topics deleted since the list was read: not the model's failure.
                recordFailure(course, model);
            }
            const percent = Math.round(((i + 1) / pending.length) * 100);
            handle.update({ progress: percent, percent });
        }
        if (abort.signal.aborted) handle.cancelled();
        else if (unreachable >= MAX_CONSECUTIVE_FAILURES) handle.fail('The AI endpoint could not be reached', lastError);
        else {
            handle.finish();
            // A full list may have left courses behind it.
            if (pending.length >= MAX_PER_SWEEP) scheduleSearchWords();
        }
    } catch (err) {
        handle.fail(err?.message, err);
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
