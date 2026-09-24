/**
 * What a curriculum node may contain, and the one normalizer both importers run.
 *
 * There are two ways a whole course enters this app from outside — plain JSON
 * (`POST /api/import`) and a `.studyvault` bundle (`POST /api/import/bundle`) —
 * and they had drifted into two different validators with different opinions
 * about the same file. The bundle path clamped an invalid status and skipped a
 * malformed node; the JSON path rejected the status outright and had no bound on
 * tree depth or node count at all, while recursing inside a transaction. Neither
 * looked at a resource URL, which is the field that ends up in an `href`.
 *
 * Both threats are the same threat: a course file is something you were *given*.
 * So there is now one normalizer, it returns a clean tree that the caller only
 * has to insert, and every cap and repair lives here where a gate can read it.
 *
 * A node may also carry `questions` — GRADED ones, which the importer turns
 * into a real quiz on that topic. Until it could, a course written outside the
 * app had exactly one place to put practice (`description`, as prose), so its
 * questions could not be answered, graded, scheduled, counted as evidence or
 * reached by the feed: the learner tapped a `<details>` to reveal the key and
 * ticked the topic off. See `normalizeImportQuestions` for what is checked and
 * what is injected.
 *
 * **Repairs warn rather than reject.** A single unknown resource type should not
 * throw away a 4000-node course the learner just spent an hour generating — but
 * a silent repair is how an imported Dutch course ends up flagged as English, so
 * every repair is reported back through the API response. Only structural
 * damage (not an object, no title, children that are not an array) and the
 * bounds throw, because past those points there is nothing to import.
 *
 * No-import module on purpose — same reason as `arithmetic.js` and
 * `questionOptions.js`: `tools/import-gates.mjs` must apply the identical rules
 * without opening a database. That is also why `isSupportedLanguage` is injected
 * rather than imported: `server/language.js` pulls in `database.js`.
 */

import { sanitizeUrl } from './urlSafety.js';
import { cleanRegionLabel } from './curriculumLabel.js';

export const VALID_NODE_STATUSES = ['not_started', 'in_progress', 'completed', 'skipped'];

// `course_link` is a legacy alias for `course` that real rows still carry, so it
// stays accepted. Anything outside this set renders as `link` (ResourceList's
// `TYPE_CONFIG[type] || TYPE_CONFIG.link`), which is a fine fallback but a bad
// silence — it is normalized here so the importer can say it happened.
export const VALID_RESOURCE_TYPES = [
    'article', 'video', 'book', 'documentation', 'tutorial',
    'tool', 'course', 'course_link', 'practice', 'link',
];

/**
 * Normalize an author- or model-supplied resource type to a known one.
 *
 * The LIST was deduplicated into this module, but the function wrapping it was
 * left as two byte-different copies (index.js and agentic.js), each carrying a
 * comment saying the deduplication was done. They happened to agree, so nothing
 * broke — which is exactly how the list itself drifted into three copies before
 * it: the vocabulary and the rule that applies it have to live together, or the
 * next edit only lands on one of them.
 */
export function sanitizeResourceType(type) {
    if (!type || typeof type !== 'string') return 'article';
    const normalized = type.toLowerCase().trim();
    return VALID_RESOURCE_TYPES.includes(normalized) ? normalized : 'article';
}

/**
 * Bounds. `importNode` recurses, and it does so inside a `db.transaction`, so a
 * deeply nested `children` chain in a hand-edited or hostile file overflows the
 * stack mid-transaction. 20 levels is far past the 3–4 the authoring brief asks
 * for and the deepest the AI pipeline ever emits.
 */
export const MAX_IMPORT_DEPTH = 20;
export const MAX_IMPORT_NODES = 20000;
export const MAX_WARNINGS = 40;

/**
 * How many graded questions one topic may carry, and how many a whole file may.
 *
 * A course written outside the app has nowhere to put practice except
 * `description`: a real one shipped 4,315 questions as markdown prose with
 * the key folded into a `<details>` — ungraded, unschedulable, invisible to
 * BKT, and chopped into "part 1 / part 2 / part 3" nodes by the 10,000-character
 * prose cap rather than by anything pedagogical. The caps here are the ones
 * that course actually needs (its fullest topic carries 60), with room, and
 * they exist for the same reason every other cap in this file does: a hostile
 * or malformed file must not be able to ask for unbounded work inside a
 * transaction.
 */
export const MAX_QUESTIONS_PER_NODE = 200;
export const MAX_IMPORT_QUESTIONS = 50000;

/**
 * How many flashcards one topic may carry, and how many a whole file may.
 *
 * A course is not only what it explains and asks: a language course leaves
 * vocabulary and listening behind it, and until this field existed those had
 * to travel as a SEPARATE Anki deck that imported as a second project with no
 * link to the topics they came from. The per-topic cap is generous because a
 * listening topic legitimately carries a clip per sentence; the file cap is the
 * same shape of bound every other cap here is — no file may ask for unbounded
 * work inside one transaction.
 */
export const MAX_CARDS_PER_NODE = 500;
export const MAX_IMPORT_CARDS = 20000;

export const LIMITS = {
    projectName: 500,
    projectDescription: 5000,
    projectVersion: 40,
    title: 500,
    description: 10000,
    notes: 50000,
    questionStem: 2000,
    answer: 2000,
    explanation: 4000,
    cardSide: 4000,
    cardExtra: 4000,
    mediaName: 200,
    modelName: 200,
};

/**
 * The fields the importer actually reads. Exported so `tools/import-gates.mjs`
 * can hold them against the field tables in the outline brief the app serves
 * (`briefs/outline.md`) — that text is hand-maintained against a validator
 * buried in a 3000-line file, and it has drifted before.
 */
export const READ_PROJECT_FIELDS = ['name', 'description', 'color', 'icon', 'content_language', 'version', 'uuid', 'new_per_day'];
export const READ_NODE_FIELDS = ['title', 'description', 'notes', 'status', 'is_note', 'uuid', 'children', 'questions', 'flashcards', 'resources'];
export const READ_RESOURCE_FIELDS = ['title', 'url', 'type', 'completed', 'uuid'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** RFC-4122 v4, matching what `database.js` mints from randomblob(). */
export function isValidUuid(value) {
    return typeof value === 'string' && UUID_RE.test(value);
}

/** Structural failure: nothing importable past this point. */
export class ImportError extends Error {
    constructor(message) { super(message); this.name = 'ImportError'; }
}

/**
 * Collects repairs without letting a hostile file balloon the response: a file
 * with 5000 bad URLs produces 40 lines and a count, not 5000 lines.
 */
class Warnings {
    constructor() { this.items = []; this.extra = 0; }
    add(message) {
        if (this.items.length < MAX_WARNINGS) this.items.push(message);
        else this.extra++;
    }
    list() {
        return this.extra
            ? [...this.items, `…and ${this.extra} more of the same kind`]
            : [...this.items];
    }
}

const str = (value, max) => String(value == null ? '' : value).slice(0, max);

/**
 * Normalize the project header.
 * @param {object} project
 * @param {{isSupportedLanguage: (code: string) => boolean}} deps
 */
export function normalizeImportProject(project, { isSupportedLanguage }) {
    if (!project || typeof project !== 'object') throw new ImportError('Invalid format: missing project object');
    if (!project.name || typeof project.name !== 'string') throw new ImportError('Invalid format: project must have a name');

    const warnings = new Warnings();

    // An unrecognised code becoming '' in silence means "follow the material" —
    // a shared Dutch course would have every future lesson authored in whatever
    // language the importer's model guessed from the titles — so the fallback
    // says so.
    let contentLanguage = String(project.content_language || '').trim();
    if (contentLanguage && !isSupportedLanguage(contentLanguage)) {
        warnings.add(`Unknown content language "${contentLanguage}" — the project will infer its language from the material instead.`);
        contentLanguage = '';
    }

    let uuid = null;
    if (project.uuid != null) {
        if (isValidUuid(project.uuid)) uuid = String(project.uuid).toLowerCase();
        else warnings.add('Project uuid is not a valid v4 uuid — a new one was minted.');
    }

    // How many NEW cards a day the course's author thinks is right: a
    // vocabulary course knows its own pace better than the importer's default
    // does. Absent means the app's own dial; anything unusable says so.
    let newPerDay = undefined;
    if (project.new_per_day != null) {
        const n = Number(project.new_per_day);
        if (Number.isInteger(n) && n >= 0 && n <= 9999) newPerDay = n;
        else warnings.add(`Ignored new_per_day "${String(project.new_per_day).slice(0, 20)}" — it must be a whole number of cards.`);
    }

    return {
        project: {
            name: str(project.name, LIMITS.projectName),
            description: str(project.description, LIMITS.projectDescription),
            color: typeof project.color === 'string' && project.color.trim() ? project.color.trim() : '#3B82F6',
            icon: typeof project.icon === 'string' && project.icon.trim() ? project.icon.trim() : 'folder',
            content_language: contentLanguage,
            version: str(project.version, LIMITS.projectVersion).trim(),
            uuid,
            new_per_day: newPerDay,
        },
        warnings: warnings.list(),
    };
}

/**
 * Normalize the node tree into exactly what the importers insert.
 *
 * @param {unknown} nodes
 * @param {object} [deps] required only when a node carries `questions`:
 *   `normalizeQuestionFormat` and `sanitizeQuestionMedia` (`answerFormats.js`,
 *   `agentic.js`) and `questionDefects` (`feedQuality.js`). Injected rather
 *   than imported for the same reason `isSupportedLanguage` is — they reach
 *   `database.js`, and this module must stay openable by a gate that has none.
 * @returns {{nodes: object[], warnings: string[], count: number, questionCount: number, cardCount: number}}
 */
export function normalizeImportTree(nodes, deps = {}) {
    if (!nodes) throw new ImportError('Invalid format: missing nodes array');
    if (!Array.isArray(nodes)) throw new ImportError('Invalid format: nodes must be an array');

    const warnings = new Warnings();
    let count = 0;
    const questionBudget = { left: MAX_IMPORT_QUESTIONS, total: 0 };
    const cardBudget = { left: MAX_IMPORT_CARDS, total: 0 };

    const walk = (list, path, depth) => {
        if (depth > MAX_IMPORT_DEPTH) {
            throw new ImportError(`Curriculum nests deeper than ${MAX_IMPORT_DEPTH} levels at ${path} — this is almost always a malformed file.`);
        }
        return list.map((node, i) => {
            const at = `${path}[${i}]`;
            if (!node || typeof node !== 'object' || Array.isArray(node)) throw new ImportError(`Invalid node at ${at}: must be an object`);
            if (!node.title || typeof node.title !== 'string') throw new ImportError(`Invalid node at ${at}: must have a title string`);

            if (++count > MAX_IMPORT_NODES) {
                throw new ImportError(`Curriculum has more than ${MAX_IMPORT_NODES} nodes — this is almost always a malformed file.`);
            }

            const isNote = node.is_note ? 1 : 0;

            let status = 'not_started';
            if (node.status != null && node.status !== '') {
                if (VALID_NODE_STATUSES.includes(node.status)) status = node.status;
                else warnings.add(`Unknown status "${node.status}" at ${at} — imported as not started.`);
            }

            let uuid = null;
            if (node.uuid != null) {
                if (isValidUuid(node.uuid)) uuid = String(node.uuid).toLowerCase();
                else warnings.add(`Invalid uuid at ${at} — a new one was minted.`);
            }

            let children = [];
            if (node.children != null) {
                if (!Array.isArray(node.children)) throw new ImportError(`Invalid children at ${at}: must be an array`);
                children = walk(node.children, `${at}.children`, depth + 1);
            }

            return {
                title: str(node.title, LIMITS.title),
                description: str(node.description, LIMITS.description),
                notes: str(node.notes, LIMITS.notes),
                status,
                is_note: isNote,
                uuid,
                resources: normalizeResources(node.resources, at, warnings),
                questions: normalizeImportQuestions(node.questions, at, warnings, deps, questionBudget, isNote),
                flashcards: normalizeImportFlashcards(node.flashcards, at, warnings, cardBudget, isNote),
                children,
            };
        });
    };

    const tree = walk(nodes, 'nodes', 1);
    return { nodes: tree, warnings: warnings.list(), count, questionCount: questionBudget.total, cardCount: cardBudget.total };
}

/**
 * The graded questions attached to one topic.
 *
 * **This is the field that did not exist**, and its absence is the whole reason
 * an imported course's practice was prose. A node could carry a title, a
 * reading, private notes and links — everything except the one thing a mastery
 * engine measures. So an author outside the app had a choice between writing
 * questions nobody could grade and writing no questions at all.
 *
 * Two halves, deliberately split:
 *
 *  * **Structure lives here** — it is an array, it is capped, its strings are
 *    bounded, and a broken entry is DROPPED WITH A WARNING rather than throwing
 *    away the course around it. That is this file's standing doctrine (repairs
 *    warn, only structural damage throws) and it matters more here than
 *    anywhere: a 4,000-question file with one malformed question is still a
 *    course worth having.
 *  * **What makes a question honest is injected** — `normalizeQuestionFormat`
 *    (the answer-format registry: is there a key, does it match an option, is
 *    the ordering really an ordering), `questionDefects` (the same mechanical
 *    gate the feed and the quiz apply) and `sanitizeQuestionMedia`. Injected
 *    for the same reason `isSupportedLanguage` is: those modules reach
 *    `database.js`, and this one must stay openable by a gate that has no
 *    database. There is no fallback — a caller that forgets them would import
 *    unvetted questions in silence, which is precisely the failure this field
 *    exists to end.
 *
 * `questionDefects` is called with no node id on purpose. Its scaffolding rule
 * ("a question about the app's own filing rather than the subject") needs a
 * node that does not exist yet at import time, and it guards against a fault of
 * questions the app AUTHORS from its own context — an imported course's
 * questions came from real material and are not at risk of it.
 */
function normalizeImportQuestions(questions, at, warnings, deps, budget, isNote) {
    if (questions == null) return [];
    if (!Array.isArray(questions)) throw new ImportError(`Invalid questions at ${at}: must be an array`);
    if (!questions.length) return [];

    // A note is content, not structure: it carries no weight, is never
    // scheduled, and is taught as its topic's material. Evidence recorded
    // against one would be evidence for something the engine does not count, so
    // questions go on the topic that owns the note, and a file that puts them
    // elsewhere is told rather than quietly half-imported.
    if (isNote) {
        warnings.add(`Ignored ${questions.length} question(s) at ${at}: they are on a reference note, and questions belong on the topic it explains.`);
        return [];
    }

    const { normalizeQuestionFormat, questionDefects, sanitizeQuestionMedia } = deps;
    if (!normalizeQuestionFormat || !questionDefects || !sanitizeQuestionMedia) {
        throw new Error('normalizeImportTree: questions need normalizeQuestionFormat, questionDefects and sanitizeQuestionMedia injected');
    }

    const out = [];
    const seenUuids = new Set();
    // Nothing inside a question is TRUNCATED to fit. Everywhere else in this
    // file an over-long string is cut, because half a title is still a title —
    // but half a key grades every right answer as wrong, and half an ordering
    // is not even parseable JSON. Over a cap, the question is dropped and said
    // so; the rest of the topic imports.
    for (const [j, raw] of questions.slice(0, MAX_QUESTIONS_PER_NODE).entries()) {
        const where = `${at}.questions[${j}]`;
        if (budget.left <= 0) { budget.exhausted = true; break; }
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            warnings.add(`Dropped a question at ${where}: it is not an object.`);
            continue;
        }
        const stem = typeof raw.question === 'string' ? raw.question.trim() : '';
        if (!stem) {
            warnings.add(`Dropped a question at ${where}: it has no question text.`);
            continue;
        }
        if (stem.length > LIMITS.questionStem) {
            warnings.add(`Dropped a question at ${where}: its text is longer than ${LIMITS.questionStem} characters.`);
            continue;
        }

        // The format registry owns everything that differs between formats and
        // returns null rather than guessing a key — which is the one repair
        // that must never happen, because a wrong key writes wrong mastery.
        const shaped = normalizeQuestionFormat(raw);
        if (!shaped) {
            warnings.add(`Dropped "${stem.slice(0, 50)}" (${where}): "${String(raw.type ?? '').slice(0, 40)}" is not an answer format this app can grade, or the question has no identifiable answer.`);
            continue;
        }

        const question = { question: stem, type: raw.type, ...shaped };
        // A picture question rebuilt key by key without this is silently
        // unanswerable — the stem asks about an image that no longer travels
        // with it. Undefined when there is none, so the row stays clean.
        const media = sanitizeQuestionMedia(raw.media);
        if (media) question.media = media;

        if (String(question.correct_answer ?? '').length > LIMITS.answer) {
            warnings.add(`Dropped "${stem.slice(0, 50)}" (${where}): its answer is longer than ${LIMITS.answer} characters.`);
            continue;
        }
        if (String(question.explanation ?? '').length > LIMITS.explanation) {
            warnings.add(`Dropped "${stem.slice(0, 50)}" (${where}): its explanation is longer than ${LIMITS.explanation} characters.`);
            continue;
        }

        const defects = questionDefects(question);
        if (defects.length) {
            warnings.add(`Dropped "${stem.slice(0, 50)}" (${where}): ${defects.join('; ')}.`);
            continue;
        }
        // The question's identity, which is what lets a later edition say
        // which question it means. Scoped to the topic: a question is found
        // through its topic's uuid, so two topics may reuse one. Absent or
        // unusable, the database mints one when the bank is stored.
        const uuid = itemUuid(raw.uuid, where, warnings, seenUuids);
        if (uuid) question.uuid = uuid;
        const model = declaredModel(raw.generated_by, where, warnings);
        if (model) question.generated_by = model;
        out.push(question);
        budget.left--;
        budget.total++;
    }

    if (questions.length > MAX_QUESTIONS_PER_NODE) {
        warnings.add(`A topic at ${at} carried ${questions.length} questions — only the first ${MAX_QUESTIONS_PER_NODE} were imported.`);
    }
    // Once per file, not once per node: the budget runs out in the middle of a
    // tree and every node after it would otherwise repeat the same line.
    if (budget.exhausted && !budget.reported) {
        budget.reported = true;
        warnings.add(`The file holds more than ${MAX_IMPORT_QUESTIONS} questions — the rest were ignored.`);
    }
    return out;
}

/**
 * A card's media, as the file WRITES it — by name, never by hash.
 *
 * The stored shape (`flashcards.media`, see database.js) keys a clip by its
 * content hash, because that is what makes a blob referenced. A file cannot
 * know that hash: it ships the bytes beside the manifest (`media/<name>` in a
 * bundle) and the importer hashes them on the way in, exactly as the Anki
 * door does. So a card names its files, and the bundle importer resolves each
 * name against what it actually stored; a name it could not resolve is dropped
 * WITH A WARNING and the card survives — a listening card without its clip is
 * a worse card, not a missing one. The plain JSON door carries no bytes, so
 * every name is unresolvable there, and the same rule applies.
 */
const MEDIA_SIDES = ['front', 'back'];
export const CARD_MEDIA_KINDS = ['image', 'audio'];

function normalizeCardMedia(raw, where, warnings) {
    if (raw == null) return null;
    if (typeof raw !== 'object' || Array.isArray(raw)) {
        warnings.add(`Ignored the media of a card at ${where}: it must be an object with "front" and/or "back" lists.`);
        return null;
    }
    const out = {};
    let any = false;
    for (const side of MEDIA_SIDES) {
        const list = raw[side];
        if (list == null) continue;
        if (!Array.isArray(list)) {
            warnings.add(`Ignored the ${side} media of a card at ${where}: it must be a list.`);
            continue;
        }
        const clean = [];
        for (const m of list) {
            const name = typeof m?.name === 'string' ? m.name.trim() : '';
            if (!name || name.length > LIMITS.mediaName || /[\\/]|\.\./.test(name)) {
                warnings.add(`Dropped a media reference at ${where}: a file is named by a plain file name, nothing else.`);
                continue;
            }
            const kind = typeof m.kind === 'string' && CARD_MEDIA_KINDS.includes(m.kind) ? m.kind : null;
            clean.push({ name, ...(kind ? { kind } : {}), ...(typeof m.alt === 'string' && m.alt ? { alt: m.alt.slice(0, 500) } : {}) });
        }
        if (clean.length) { out[side] = clean; any = true; }
    }
    return any ? out : null;
}

/**
 * The flashcards attached to one topic.
 *
 * Same doctrine as the questions above: nothing inside a card is truncated
 * (half an answer is a card that teaches the wrong thing), a bad card costs
 * its own row and never the topic, a note carries none, and the budgets report
 * once per file. What arrives here is the card row itself — `front`, `back`,
 * `extra` (answer-side supporting lines), `extra_front` (question-side ones),
 * and `media` by file name — so the shape needs no second vocabulary and the
 * scheduler starts every card new: schedule state is the learner's, not the
 * course's, and it never travels in a course file.
 */
function normalizeImportFlashcards(cards, at, warnings, budget, isNote) {
    if (cards == null) return [];
    if (!Array.isArray(cards)) throw new ImportError(`Invalid flashcards at ${at}: must be an array`);
    if (!cards.length) return [];
    if (isNote) {
        warnings.add(`Ignored ${cards.length} flashcard(s) at ${at}: they are on a reference note, and cards belong on the topic it explains.`);
        return [];
    }

    const side = (v) => (typeof v === 'string' ? v.trim() : '');
    const out = [];
    for (const [j, raw] of cards.slice(0, MAX_CARDS_PER_NODE).entries()) {
        const where = `${at}.flashcards[${j}]`;
        if (budget.left <= 0) { budget.exhausted = true; break; }
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            warnings.add(`Dropped a flashcard at ${where}: it is not an object.`);
            continue;
        }
        const front = side(raw.front);
        const back = side(raw.back);
        if (!front || !back) {
            warnings.add(`Dropped a flashcard at ${where}: it needs both a front and a back.`);
            continue;
        }
        if (front.length > LIMITS.cardSide || back.length > LIMITS.cardSide) {
            warnings.add(`Dropped "${front.slice(0, 50)}" (${where}): a side is longer than ${LIMITS.cardSide} characters.`);
            continue;
        }
        const extra = side(raw.extra);
        const extraFront = side(raw.extra_front);
        if (extra.length > LIMITS.cardExtra || extraFront.length > LIMITS.cardExtra) {
            warnings.add(`Dropped "${front.slice(0, 50)}" (${where}): its supporting lines are longer than ${LIMITS.cardExtra} characters.`);
            continue;
        }
        const card = { front, back, extra: extra || null, extra_front: extraFront || null };
        const media = normalizeCardMedia(raw.media, where, warnings);
        if (media) card.media = media;
        // A card's uuid is unique across the whole library (the column is
        // UNIQUE), so a repeat is caught across the file, not per topic.
        const uuid = itemUuid(raw.uuid, where, warnings, budget.uuids ??= new Set());
        if (uuid) card.uuid = uuid;
        const model = declaredModel(raw.generated_by, where, warnings);
        if (model) card.generated_by = model;
        out.push(card);
        budget.left--;
        budget.total++;
    }

    if (cards.length > MAX_CARDS_PER_NODE) {
        warnings.add(`A topic at ${at} carried ${cards.length} flashcards — only the first ${MAX_CARDS_PER_NODE} were imported.`);
    }
    if (budget.exhausted && !budget.reported) {
        budget.reported = true;
        warnings.add(`The file holds more than ${MAX_IMPORT_CARDS} flashcards — the rest were ignored.`);
    }
    return out;
}

/**
 * A question's or a card's uuid as the file wrote it: lower-cased when it is a
 * v4 uuid nobody earlier in its scope claimed, otherwise null with a warning —
 * never a dropped item, because a missing id costs only the ability to update
 * that one item in place, and the database mints a fresh one on insert.
 */
function itemUuid(value, where, warnings, seen) {
    if (value == null) return null;
    if (!isValidUuid(value)) {
        warnings.add(`Invalid uuid at ${where} — not a valid v4 uuid, so a new one was minted.`);
        return null;
    }
    const uuid = String(value).toLowerCase();
    if (seen.has(uuid)) {
        warnings.add(`Duplicate uuid at ${where} — an earlier item claimed the same uuid, so this one gets a new one.`);
        return null;
    }
    seen.add(uuid);
    return uuid;
}

/**
 * Which model the FILE says wrote a question or a card: a model id, kept as the
 * file's claim. It is kept, not dropped, because a shared course must not pass a
 * model's work off as its author's, and an importer that forgot the mark would
 * wash it out of every copy made after it. Anything that is not a plain name
 * is ignored with a warning; the item always survives.
 */
function declaredModel(value, where, warnings) {
    if (value == null || value === '') return null;
    const name = typeof value === 'string' ? value.trim() : '';
    if (!name || name.length > LIMITS.modelName) {
        warnings.add(`Ignored the generated_by at ${where} — it must be the name of the model that wrote the item.`);
        return null;
    }
    return name;
}

function normalizeResources(resources, at, warnings) {
    if (resources == null) return [];
    if (!Array.isArray(resources)) throw new ImportError(`Invalid resources at ${at}: must be an array`);

    const out = [];
    for (let j = 0; j < resources.length; j++) {
        const resource = resources[j];
        const where = `${at}.resources[${j}]`;
        if (!resource || typeof resource !== 'object' || Array.isArray(resource)) throw new ImportError(`Invalid resource at ${where}`);
        if (!resource.title || typeof resource.title !== 'string') throw new ImportError(`Invalid resource at ${where}: must have a title`);

        // The link is dropped, never the resource: its title still tells the
        // learner what the author meant them to look at.
        let url = '';
        const checked = sanitizeUrl(resource.url);
        if (checked.ok) url = checked.url;
        else warnings.add(`Dropped unsafe link on "${str(resource.title, 60)}" (${where}): ${checked.reason}.`);

        let type = 'link';
        if (resource.type != null && resource.type !== '') {
            if (VALID_RESOURCE_TYPES.includes(resource.type)) type = resource.type;
            else warnings.add(`Unknown resource type "${resource.type}" at ${where} — imported as a plain link.`);
        }

        let uuid = null;
        if (resource.uuid != null) {
            if (isValidUuid(resource.uuid)) uuid = String(resource.uuid).toLowerCase();
            else warnings.add(`Invalid uuid at ${where} — a new one was minted.`);
        }

        out.push({ title: str(resource.title, LIMITS.title), url, type, completed: resource.completed ? 1 : 0, uuid });
    }
    return out;
}

/* ------------------------------------------------------------------ *
 * Pass two: material merged into a course that already exists.
 *
 * `POST /api/import` always makes a NEW project, deliberately. This is the
 * other direction and a narrower promise: the course is already here, the
 * learner asked a cloud model for one phase's teaching, and the reply has to
 * land on the leaves it was written for. It is not "merge an edition" — nothing
 * here renames, reorders, deletes or reschedules anything. It only ever ADDS
 * `is_note` children under leaves that already exist, which is the one merge
 * with no decisions in it.
 *
 * Matching is by TITLE because the title is what the model was handed and told
 * to echo. `cleanRegionLabel` is the fallback for the one thing models reliably
 * do to a title anyway — adding or dropping curriculum numbering — and an
 * ambiguous match is reported rather than guessed: two leaves that clean to the
 * same label is exactly the case where picking one silently puts a lesson on
 * the wrong topic.
 * ------------------------------------------------------------------ */

export const MAX_MATERIAL_LEAVES = 200;
export const MAX_MATERIAL_PER_LEAF = 12;
/**
 * An Overview at least this long is a READING, not the 2–5 sentence signpost
 * pass one writes (those measure 150–500 characters on the real library).
 * Below it a leaf still counts as unwritten and is listed for pass two.
 */
export const MATERIAL_MIN_CHARS = 1200;

/** Does this leaf already hold teaching material, by either route? */
export function leafHasMaterial({ hasNotes = false, descriptionLength = 0 } = {}) {
    return !!hasNotes || Number(descriptionLength) >= MATERIAL_MIN_CHARS;
}

/**
 * Validate a pass-two reply:
 * `{ leaves: [{ title, overview?: string, material?: [{title, description}] }] }`.
 *
 * `overview` is the reading and goes into the leaf's own Overview column —
 * the leaf IS the lesson, which is how the app's own generator and the
 * hand-built courses shape a topic. `material` is the rare separable extra
 * (a reference table, a worked paper) and becomes an attached `is_note`
 * child; a reply from the earlier brief, which used only `material`, still
 * imports. The shape is deliberately NOT the node shape: a model handed
 * `children` and `is_note` nests arbitrary trees and forgets the flag, so
 * `is_note` is applied here by construction rather than trusted.
 */
export function normalizeMaterialPayload(payload) {
    if (!payload || typeof payload !== 'object') throw new ImportError('Invalid format: expected an object');
    const leaves = payload.leaves;
    if (!Array.isArray(leaves)) throw new ImportError('Invalid format: missing "leaves" array');
    if (!leaves.length) throw new ImportError('The file contains no topics.');
    if (leaves.length > MAX_MATERIAL_LEAVES) {
        throw new ImportError(`More than ${MAX_MATERIAL_LEAVES} topics in one file — this is almost always a malformed file.`);
    }

    const warnings = new Warnings();
    const out = [];

    leaves.forEach((leaf, i) => {
        const at = `leaves[${i}]`;
        if (!leaf || typeof leaf !== 'object' || Array.isArray(leaf)) throw new ImportError(`Invalid entry at ${at}: must be an object`);
        if (!leaf.title || typeof leaf.title !== 'string') throw new ImportError(`Invalid entry at ${at}: must have a title string`);

        const list = leaf.material == null ? [] : leaf.material;
        if (!Array.isArray(list)) throw new ImportError(`Invalid material at ${at}: must be an array`);
        if (leaf.overview != null && typeof leaf.overview !== 'string') throw new ImportError(`Invalid overview at ${at}: must be a string`);
        const overview = str(leaf.overview, LIMITS.description).trim();

        const material = [];
        list.slice(0, MAX_MATERIAL_PER_LEAF).forEach((item, j) => {
            const where = `${at}.material[${j}]`;
            if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ImportError(`Invalid material at ${where}`);
            const description = str(item.description, LIMITS.description);
            // A material node with no body is the stub this whole two-pass split
            // exists to prevent. Dropping it is the honest outcome: the topic is
            // then still listed as unwritten and can be asked for again, where
            // an empty reading would look done forever.
            if (!description.trim()) {
                warnings.add(`Dropped an empty reading at ${where} — nothing was written for it.`);
                return;
            }
            const title = str(item.title, LIMITS.title).trim() || str(leaf.title, LIMITS.title);
            material.push({ title, description });
        });

        if (list.length > MAX_MATERIAL_PER_LEAF) {
            warnings.add(`"${str(leaf.title, 60)}" carried more than ${MAX_MATERIAL_PER_LEAF} readings — the extras were ignored.`);
        }
        if (!material.length && !overview) {
            warnings.add(`"${str(leaf.title, 60)}" had no usable material and was skipped.`);
            return;
        }
        out.push({ title: str(leaf.title, LIMITS.title), overview: overview || null, material });
    });

    if (!out.length) throw new ImportError('No usable material in the file — every entry was empty.');
    return { leaves: out, warnings: warnings.list() };
}

/**
 * Resolve payload titles against the course's real leaves.
 *
 * @param {{title: string}[]} payloadLeaves  from `normalizeMaterialPayload`
 * @param {{id: number, title: string, hasMaterial?: boolean}[]} courseLeaves
 * @returns {{matches: object[], unmatched: object[]}}
 */
export function matchMaterialToLeaves(payloadLeaves, courseLeaves, { replace = false } = {}) {
    const exact = new Map();
    const cleaned = new Map();
    const index = (map, key, leaf) => {
        const list = map.get(key);
        if (list) list.push(leaf);
        else map.set(key, [leaf]);
    };
    for (const leaf of courseLeaves) {
        index(exact, String(leaf.title || '').trim().toLowerCase(), leaf);
        index(cleaned, cleanRegionLabel(leaf.title).toLowerCase(), leaf);
    }

    const matches = [];
    const unmatched = [];
    const used = new Set();

    for (const entry of payloadLeaves) {
        const raw = entry.title.trim().toLowerCase();
        let candidates = exact.get(raw) || [];
        if (!candidates.length) candidates = cleaned.get(cleanRegionLabel(entry.title).toLowerCase()) || [];

        const free = candidates.filter(c => !used.has(c.id));
        if (!free.length) {
            unmatched.push({
                title: entry.title,
                reason: candidates.length ? 'already filled from this file' : 'no topic with this title',
            });
            continue;
        }
        if (free.length > 1) {
            unmatched.push({ title: entry.title, reason: 'more than one topic has this title' });
            continue;
        }
        const target = free[0];
        if (target.hasMaterial && !replace) {
            unmatched.push({ title: entry.title, reason: 'this topic already has material' });
            continue;
        }
        used.add(target.id);
        matches.push({ nodeId: target.id, title: target.title, overview: entry.overview ?? null, material: entry.material, replacing: !!target.hasMaterial });
    }

    return { matches, unmatched };
}
