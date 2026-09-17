import db from './database.js';
import { generateResponse, AI_PROMPTS } from './ai.js';
import { parseJsonWithRepair, escapeLatexBackslashes } from './agentic.js';
import { sameCode, parseNumber, normalizeTyped } from './answerFormats.js';
import {
    canonicalOption, sameOption, keyEchoesStem, keyIsLengthOutlier, isShapeOnlyOption, symmetricAboutStem } from './questionOptions.js';
import {
    SCRIPTS, getNodeLanguage, closerPatterns, nativeScripts, driftedToEnglish,
} from './language.js';
import { linearCombinationFaults } from './arithmetic.js';

/**
 * Quality gates for AI-authored feed content.
 *
 * The split here is deliberate and it is the whole design: MECHANICAL checks
 * (cheap, deterministic, always run) do everything that can be decided by
 * looking at the text, and MODEL checks (one extra call, background only) do the
 * two things that provably cannot — whether an answer key is actually right, and
 * whether a visual depicts what the prose beside it claims.
 *
 * Every gate fails CLOSED toward serving less rather than serving wrong: a
 * question that cannot be verified is dropped (the lesson still teaches), a
 * visual that cannot be defended is stripped (the lesson still reads). Nothing
 * here ever throws out of the generator — a checker that breaks must not stop
 * the feed.
 */

/**
 * Strip the trailing paragraph that certifies the learner rather than teaching
 * them ("You can now…"). The prompt bans these, but a pattern this deeply worn
 * into instruction-tuned models survives being told not to — so it is also cut
 * mechanically, and only ever as a WHOLE trailing paragraph (never mid-lesson,
 * where the same words can be a legitimate sentence).
 *
 * `lang` is the project's declared language (server/language.js), or null for
 * "unset", which means English patterns — the historical behaviour. A declared
 * language with no patterns in the table strips NOTHING rather than guessing:
 * the closer is a style defect, and deleting a real closing argument because
 * nobody has written a Czech regex yet is the worse of the two failures. Same
 * posture as the rest of this file — fail toward serving less, but never toward
 * destroying teaching.
 *
 * Two shapes are recognised. The ANCHORED `closer` catches the paragraph that
 * opens with the certification ("You can now…"). The unanchored `certify` catches
 * the same claim buried in a subordinate clause ("Mastering this visual scan
 * ensures you can bridge a diagram to a numerical answer") — a real shipped
 * closer that the anchor could never see, because it begins with a gerund. Since
 * an unanchored test is far easier to trip by accident, it applies only to a
 * final paragraph of at most CERTIFY_MAX_SENTENCES sentences: a closing argument
 * that runs three sentences is teaching, a certification is always a flourish.
 */
const CERTIFY_MAX_SENTENCES = 2;

function sentenceCount(text) {
    // Protect decimals and common abbreviations from being read as sentence ends
    // — "0.65 m" must not count as two sentences.
    const masked = String(text).replace(/\d[.,]\d/g, '00').replace(/\b(?:e\.g|i\.e|etc|vs|cf)\./gi, 'xx');
    return (masked.match(/[.!?](?:\s|$)/g) || []).length || 1;
}

export function stripSelfCertifyingCloser(markdown, lang = null) {
    const text = String(markdown || '').trimEnd();
    const patterns = closerPatterns(lang || { code: 'en' });
    if (!patterns) return text;
    const paras = text.split(/\n\s*\n/);
    while (paras.length > 1) {
        const last = paras[paras.length - 1].trim();
        // Only a short, prose-only paragraph qualifies: never touch a fence, a
        // heading, a list, a formula block, or a real closing argument.
        const isProse = last.length < 400
            && !last.includes('```')
            && !last.startsWith('#')
            && !last.startsWith('-')
            && !last.startsWith('$$')
            && !/^\d+\./.test(last);
        const stripped = last.replace(/^[-*\s]+/, '');
        // A closer is ABOUT the learner. Requiring a second-person reference
        // keeps a legitimate final paragraph that merely opens with the same
        // words ("With this equation, the period follows directly").
        const opensWithOne = patterns.closer.test(stripped);
        const containsOne = Boolean(patterns.certify)
            && sentenceCount(stripped) <= CERTIFY_MAX_SENTENCES
            && patterns.certify.test(stripped);
        if (!isProse || (!opensWithOne && !containsOne) || !patterns.learnerRef.test(stripped)) break;
        paras.pop();
    }
    return paras.join('\n\n').trimEnd();
}

/**
 * Text used to decide which scripts are legitimate in this lesson.
 *
 * Scoped to the whole PROJECT, not the node. A course on Japanese is entitled to
 * kana everywhere in it, but the individual topic that needs them most ("Test
 * yourself with the kana quiz") can easily be titled and described entirely in
 * English — so a node-scoped reference rejects the very lessons that are
 * supposed to contain the script. Project scope is the honest unit: a Dutch
 * physics course contains no Han characters anywhere, so a Chinese word dropped
 * into one of its lessons is still caught.
 */
const SCRIPT_REFERENCE_CACHE = new Map();

function nodeScriptReference(nodeId) {
    try {
        const projectId = db.prepare('SELECT project_id FROM nodes WHERE id = ?').get(nodeId)?.project_id;
        if (projectId == null) return '';
        if (SCRIPT_REFERENCE_CACHE.has(projectId)) return SCRIPT_REFERENCE_CACHE.get(projectId);
        const project = db.prepare('SELECT name, description FROM projects WHERE id = ?').get(projectId) || {};
        const nodes = db.prepare(
            'SELECT title, description, notes FROM nodes WHERE project_id = ? LIMIT 2000',
        ).all(projectId);
        const reference = [project.name, project.description,
            ...nodes.flatMap(n => [n.title, n.description, n.notes])].filter(Boolean).join(' ');
        SCRIPT_REFERENCE_CACHE.set(projectId, reference);
        return reference;
    } catch {
        return '';
    }
}

/**
 * Mechanical checks on a freshly written lesson. Returns an array of problem
 * strings — empty means it passes. Caller retries on a non-empty result.
 */
export function lessonDefects(markdown, nodeId) {
    const problems = [];
    const text = String(markdown || '');

    if (text.trim().length < 200) problems.push('the segment is too short to teach anything');

    // An unclosed fence means a visual (or code block) will swallow the rest of
    // the lesson. clampLesson drops a fence it had to cut; this catches a model
    // that simply never closed one.
    const fences = text.match(/^```/gm) || [];
    if (fences.length % 2 !== 0) problems.push('a fenced block was opened and never closed');

    // Script leakage. A script is legitimate if the project DECLARES a language
    // that writes in it, or (unchanged) if the project's own material already
    // uses it — a Japanese course inside an otherwise-Dutch project keeps its
    // kana either way.
    const lang = getNodeLanguage(nodeId);
    const native = nativeScripts(lang);
    const reference = nodeScriptReference(nodeId);
    for (const { name, re } of SCRIPTS) {
        if (native.has(name)) continue;
        if (re.test(text) && !re.test(reference)) {
            problems.push(`${name} characters leaked into a lesson whose subject does not use them`);
        }
    }

    // Language drift — the failure the script check is structurally blind to.
    // A model asked for Polish and reverting to English produces text in the
    // SAME script, so nothing above sees it, and most of the languages people
    // actually study in are Latin-script. Only checkable once the project has
    // declared what it is supposed to be, which is the whole reason the
    // declaration exists.
    if (driftedToEnglish(text, lang)) {
        problems.push(`the segment is written in English, but this project is studied in ${lang.name}`);
    }

    // ASCII art: the guide bans it because it collapses on a phone, and it is
    // otherwise invisible to every other check.
    if (/^\s*[|+][-=+|_\s]{6,}[|+]\s*$/m.test(text)) problems.push('the segment draws a picture out of characters');

    // Arithmetic the segment states and gets wrong, where it can be settled with
    // no model at all: a sum of multiples of one symbol that does not add up.
    // Mechanical-before-model is the standing preference here, and it is the one
    // arithmetic check that still works when no model is reachable.
    for (const fault of linearCombinationFaults(stripSpecFences(text))) {
        problems.push(`the equation "${fault.statement}" does not add up — ${fault.expected}`);
    }

    return problems;
}

/**
 * Is this question about the APP's own bookkeeping rather than the subject?
 *
 * `buildNodeContext` hands the author the topic's material and the app's record
 * of it — the project's name, the tree path down to the node, the node's status
 * — in one undifferentiated block, and a model asked to write a question about
 * "the context" will sometimes write one about the record. Measured on a real
 * 2,337-question library (2026-09-14): ten such questions, including
 *
 *   "According to the schedule status, how many days behind is the project?"
 *   "Under which path is the 'Download Past Papers' task located?"
 *      options: 01 — Study Phase | 00 — Setup, Logistics & Official Requirements | …
 *
 * Both were served, graded and written into BKT as evidence about physics.
 *
 * The `Schedule Status: … Days behind: N` line those first came from was deleted
 * from the context block long ago, but deleting a fact is not a rule: the `Path:`
 * and `Project:` lines are still there, still quizzable, and produced the second
 * example. So the rule lives here, where the next leak also gets caught.
 *
 * PRECISION IS THE WHOLE DESIGN, because plenty of real subjects talk this way.
 * Project management genuinely asks whether something is behind schedule; a
 * Linux course genuinely asks under which path a binary sits. So a plan word on
 * its own is never enough — the question must also point at THIS record, by the
 * project's own name, by one of this node's ancestor titles, or deictically
 * ("this course", "the path"). The one exception is citing the record as the
 * source of truth ("according to the schedule status"), which is the same fault
 * as the banned "according to the material" and is never about a subject.
 *
 * Measured against the same library: fires on 10 of 2,337, all of them real,
 * and on none of the questions about an exam's timing, a licensing authority's
 * steps, a calculator rule or an investor's milestone tranches — the four
 * shapes a looser rule reached for first.
 */
// Forms that are only ever ABOUT the record, so they need no second signal:
// citing it as the source of truth (the same fault as the banned "according to
// the material"), or naming the node's own `status` column.
const CITED_RECORD = /\b(?:according to|based on|per|as (?:shown|stated|listed) in) the (?:schedule|project) status\b|\bstatus of this (?:topic|project)\b|\bthis (?:topic|project)'?s status\b/i;

// Words for a plan's STATE or SHAPE. Project management and logistics use every
// one of them about their own subject, so they count only alongside a reference
// to THIS record.
const PLAN_TERM = /\b(?:schedule status|project status|on schedule|behind schedule|ahead of schedule|on track|off track|days? (?:behind|ahead)|section of the path|under which path)\b/i;

const DEICTIC_RECORD = /\b(?:this|the current) (?:project|course|curriculum|roadmap|study plan)\b|\bthe path\b/i;

// A heading the app numbered or labelled — "00 — Setup…", "Phase 1: …",
// "Domain B — …", "1.1 Understand…". A question that reproduces one of THESE is
// quoting the curriculum's filing; a question that happens to contain a plain
// topic title is usually just naming its subject, which is why "Under which path
// does the Filesystem Hierarchy Standard place binaries?" must survive a course
// whose chapter is called "Filesystem Hierarchy".
const DECORATED_HEADING = /^\s*(?:\d+[.)\-—:\s]|(?:phase|domain|chapter|module|unit|part|section|stage|week)\b\s*[\dA-Z]+\b)/i;

/** Letters and digits only: the em dash in a project's name is not a difference. */
const flatten = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Does the text name the app's record of THIS course? Short names are ignored
 * on purpose — a project called "C" would otherwise match every question.
 */
function namesThisRecord(nodeId, raw, flat) {
    if (DEICTIC_RECORD.test(raw)) return true;
    const node = db.prepare('SELECT project_id, parent_id FROM nodes WHERE id = ?').get(nodeId);
    if (!node) return false;

    const project = db.prepare('SELECT name FROM projects WHERE id = ?').get(node.project_id);
    if (project) {
        const full = flatten(project.name);
        // Courses are named "Subject — Qualifier", and both the learner and the
        // model refer to one by the head alone ("the Physics project").
        const head = flatten(String(project.name).split(/[—–:|(]/)[0]);
        if (full.length >= 12 && flat.includes(full)) return true;
        if (head.length >= 8 && flat.includes(head)) return true;
    }

    let id = node.parent_id;
    for (let depth = 0; id && depth < 20; depth++) {
        const parent = db.prepare('SELECT parent_id, title FROM nodes WHERE id = ?').get(id);
        if (!parent) break;
        if (DECORATED_HEADING.test(parent.title)) {
            // Numbering is not reproduced when someone means the subject, so the
            // decoration may be dropped: the real case wrote the heading
            // "00 — Setup, Logistics & Official Requirements" as just
            // "'Setup, Logistics & Official Requirements'".
            const bare = flatten(String(parent.title).replace(DECORATED_HEADING, ''));
            if (bare.length >= 12 && flat.includes(bare)) return true;
        }
        id = parent.parent_id;
    }
    return false;
}

/**
 * Options that are, verbatim, other topics in this same course. Independent of
 * any vocabulary: a question whose choices are the curriculum's own headings is
 * asking the learner to navigate the app, whatever words it used to ask it.
 */
function optionsAreCurriculumTitles(question, nodeId) {
    const options = Array.isArray(question.options) ? question.options : [];
    if (options.length < 2) return false;
    const projectId = db.prepare('SELECT project_id FROM nodes WHERE id = ?').get(nodeId)?.project_id;
    if (projectId == null) return false;
    const titles = new Set(
        db.prepare('SELECT title FROM nodes WHERE project_id = ?').all(projectId).map(r => flatten(r.title)),
    );
    // Two, not one: a topic legitimately named after the thing it teaches
    // ("Newton's Three Laws of Motion") can be a correct answer on its own.
    let matched = 0;
    for (const option of options) {
        const flat = flatten(option);
        if (flat.length >= 6 && titles.has(flat)) matched++;
    }
    return matched >= 2;
}

export function scaffoldingFaults(question, nodeId) {
    try {
        const options = Array.isArray(question?.options) ? question.options.join(' ‖ ') : '';
        const raw = `${question?.question || ''} ${options}`;
        const flat = flatten(raw);

        if (CITED_RECORD.test(raw) || (PLAN_TERM.test(raw) && namesThisRecord(nodeId, raw, flat))) {
            return ['the question is about this course\'s own schedule or place in the app, not about the subject — ask about the material instead'];
        }
        if (optionsAreCurriculumTitles(question, nodeId)) {
            return ['the options are this course\'s own topic titles, so the question tests navigating the curriculum rather than knowing anything'];
        }
        return [];
    } catch {
        // Same posture as the rest of this file: a checker that breaks must not
        // stop the feed. A missed scaffolding question is recoverable; a
        // generator that throws is not.
        return [];
    }
}

/**
 * Mechanical checks on a freshly generated question — everything decidable
 * without a model call, run BEFORE the (expensive) answer-key verifier so a
 * malformed candidate costs nothing to reject. Returns problem strings; empty
 * means it passes. Same contract as `lessonDefects`: the caller retries.
 *
 * These are all defects the verifier is structurally blind to. It is asked "what
 * is the answer", so it never looks at whether the OTHER options are well-formed
 * or whether the learner will be told why they were wrong — and all three
 * examples below shipped past it with `verified: true`.
 */
export function questionDefects(question, nodeId = null) {
    const problems = [];
    if (!question) return ['the question could not be parsed'];

    const stem = String(question.question || '').trim();
    if (stem.length < 10) problems.push('the question stem is empty or too short to answer');

    // The app's own bookkeeping is not the subject. Needs the node, so it is
    // skipped by the callers that have none (a gate case, a repair tool).
    if (nodeId != null) problems.push(...scaffoldingFaults(question, nodeId));

    // An explanation is not decoration: on a missed answer it IS the teaching,
    // and "Not quite" with nothing under it is the one outcome the feed must
    // never produce. One live true/false card had `explanation: ""`.
    if (!String(question.explanation || '').trim()) {
        problems.push('the question has no explanation, so a wrong answer teaches nothing');
    }

    if (question.type === 'multiple_choice') {
        const options = Array.isArray(question.options) ? question.options : [];
        if (options.length < 2) problems.push('a multiple-choice question needs at least two options');
        for (let i = 0; i < options.length; i++) {
            for (let j = i + 1; j < options.length; j++) {
                if (sameOption(options[i], options[j])) {
                    problems.push(`options ${i + 1} and ${j + 1} are the same value written two ways ("${String(options[i]).slice(0, 40)}" / "${String(options[j]).slice(0, 40)}")`);
                }
            }
        }
        if (options.length && !options.some(o => canonicalOption(o) === canonicalOption(question.correct_answer))) {
            problems.push('the correct answer matches none of the options');
        }
    }

    if (question.type === 'true_false') {
        if (/\?\s*$/.test(stem)) problems.push('a true/false item must be a statement to judge, not a question');
        if (!/^(true|false)$/i.test(String(question.correct_answer || '').trim())) {
            problems.push('a true/false answer must be exactly "True" or "False"');
        }
    }

    // A typed answer is compared to the key by machine, with no model to read
    // past a mistake, so the two ways this format goes wrong are both fatal to
    // the question: a key nothing could match, and a key the stem hands over.
    if (question.type === 'fill_in') {
        const key = normalizeTyped(question.correct_answer);
        if (!key) {
            problems.push('the answer to a typed question has nothing in it to grade');
        } else if (key.length > 200) {
            // Past a couple of lines, an exact-match grader is measuring
            // typing. That question wants `short_answer` and a real grader.
            problems.push('the answer is too long to be typed back exactly — this wants a short answer, not a gap');
        }
        // Precision over recall, as everywhere in this file: only a key of four
        // characters or more, and a single word only when it stands as a WHOLE
        // token in the stem. "de" appearing inside a Dutch sentence is not the
        // stem giving away an article; "gewerkt" appearing there is.
        if (key && key.length >= 4) {
            const stemText = normalizeTyped(stem);
            const gives = key.includes(' ')
                ? stemText.includes(key)
                : stemText.split(' ').includes(key);
            if (gives) problems.push(`the stem already contains the answer ("${key.slice(0, 40)}")`);
        }
    }

    if (question.type === 'numeric') {
        const key = parseNumber(question.correct_answer);
        if (key === null) problems.push('the answer to a numeric question is not a number');
        const tolerance = Number(question.tolerance);
        if (question.tolerance !== undefined && (!Number.isFinite(tolerance) || tolerance < 0)) {
            problems.push('the tolerance is not a distance the answer may be off by');
        }
        // A tolerance past half the answer's own size accepts the wrong order of
        // magnitude, which is the one error this format exists to catch.
        if (key !== null && key !== 0 && Number.isFinite(tolerance) && tolerance > Math.abs(key) * 0.5) {
            problems.push(`a tolerance of ${tolerance} accepts more than half of the answer ${key} itself`);
        }
        // The unit belongs beside the input, not inside the key: a key written
        // "9.81 m/s^2" grades a learner who typed 9.81 as wrong on some future
        // parser, and reads as two answers on the margin.
        if (/[a-zA-Z°%]/.test(String(question.correct_answer || '').replace(/[eE][-+]?\d+$/, ''))) {
            problems.push('the key carries a unit or words; a numeric key is the number alone');
        }
    }

    if (question.type === 'code') {
        if (!String(question.language || '').trim()) problems.push('a code question must name its language');
        const solution = String(question.correct_answer || '');
        if (solution.split('\n').length > 40) problems.push('the reference solution is over 40 lines — the task must be solvable in at most 15');
        // Prose in the key means the model explained instead of solving; the
        // learner would be shown an essay as "the solution".
        if (/^(?:the|this|you|here|to)\s+\w+\s+\w+/i.test(solution.trim()) && !/[;{}()=\[\]<>]/.test(solution)) {
            problems.push('the reference solution reads as prose, not code');
        }
        if (question.starter && sameCode(question.starter, solution)) problems.push('the starter code is the solution');
    }

    if (question.type === 'sequence') {
        const items = Array.isArray(question.items) ? question.items : [];
        if (items.length < 3) problems.push('an ordering question needs at least three items');
        if (items.some(i => /^\s*(?:\d{1,2}|[a-hA-H])[.)]\s/.test(String(i)))) problems.push('an item carries its own number, which gives the order away');
        let key = null;
        try { key = JSON.parse(String(question.correct_answer)); } catch { /* reported below */ }
        if (!Array.isArray(key) || key.length !== items.length || !items.every(i => key.includes(i))) {
            problems.push('the ordering key does not list exactly the items shown');
        }
    }

    return problems;
}

/**
 * Quality problems that are real but do NOT make a question unservable.
 *
 * Split from `questionDefects` on purpose. A hard defect (no explanation, key
 * matching no option) means the card would mislead, so it is never served and a
 * retry that keeps failing ends in a skipped question. A weakness means the card
 * WORKS but measures less than it should — and a skipped question measures
 * nothing at all, which is strictly worse. So the caller retries on a weakness
 * and, if every attempt is weak, serves the last one with the weakness recorded.
 *
 * All three below are ways a learner scores without understanding, which matters
 * more here than in an ordinary quiz: feed answers drive BKT, BKT drives the
 * retention readout, the decay timer and the advisory completion gate. A
 * multiple-choice item is credited at a 0.25 guess floor (GUESS_BY_QUESTION_TYPE);
 * an item with two giveaway distractors has a real floor near 0.5 and is being
 * scored as if it were four times harder to fluke.
 */
export function questionWeaknesses(question) {
    const problems = [];
    if (!question || question.type !== 'multiple_choice') return problems;
    const options = Array.isArray(question.options) ? question.options : [];
    if (options.length < 3) return problems;

    if (keyEchoesStem(question.question, options, question.correct_answer)) {
        problems.push('the correct option just repeats a number the question already states, and no distractor does — it can be picked without understanding anything');
    }
    if (keyIsLengthOutlier(options, question.correct_answer)) {
        problems.push('the correct option is far longer than every distractor, so it can be spotted by shape alone');
    }
    const sym = symmetricAboutStem(question.question, options, question.correct_answer);
    if (sym) {
        problems.push(`the key (${sym.key}) and a distractor (${sym.distractor}) sit symmetrically about ${sym.reference} in the stem — the stem does not say which side, so both are defensible; state the direction (sharp/flat, above/below, faster/slower)`);
    }
    const shapeOnly = options.filter(isShapeOnlyOption);
    if (shapeOnly.length) {
        problems.push(`"${String(shapeOnly[0]).slice(0, 40)}" is not an answer about the subject, and the options are shuffled before display so there is no "above"`);
    }
    return problems;
}

/**
 * Does this segment make claims that arithmetic can falsify?
 *
 * The gate on the (expensive) numeric audit below. A history segment, a grammar
 * segment or a purely qualitative explanation has nothing to recompute, and
 * paying a model call to be told so on every part of every topic would double
 * the cost of the whole feed for nothing.
 *
 * VISUAL SPEC fences are stripped first: a chart's numbers are the renderer's
 * business (D-021 — the model emits the formula and the engine computes the
 * values), and whether the picture matches the prose is `vetLessonVisuals`'s job,
 * not this one. Fences in a REAL language are kept, because in a programming
 * topic the code is the taught material and `int total = 5 * 3; // 15` is exactly
 * the kind of claim worth rechecking. Two independent signals are required so a
 * single stray figure — a date, a page reference, one given constant — does not
 * trigger a full audit.
 */
export const SPEC_FENCE_RE = /^```(?:mermaid|vega-lite|vega|plot|animation|p5|widget|drill|smiles|svg)\b[\s\S]*?^```/gm;

/** A `<Timeline>` / `<TimelineEvent …>` tag, opening or closing (see src/utils/timeline.ts). */
const TIMELINE_TAG_RE = /<\/?timeline(?:-?event)?(\s[^<>]*)?>/gi;

/**
 * Flatten `<Timeline>` markup to the text a reader actually sees: each event's
 * `title` survives as a line of prose (it is teaching, and the language gates
 * must still see it), the tags and the `time` badge do not.
 *
 * Without this, `time="08:30 AM"` reads to `hasComputation` as an equation with
 * a number on the right-hand side — two events would be enough to trigger the
 * expensive numeric audit on a lesson containing no arithmetic at all.
 */
export function stripTimelineTags(markdown) {
    return String(markdown || '').replace(TIMELINE_TAG_RE, (tag, attrs) => {
        const title = attrs && /\btitle\s*=\s*"([^"]*)"/i.exec(attrs);
        return title ? `\n${title[1]}\n` : '';
    });
}

export function stripSpecFences(markdown) {
    return stripTimelineTags(String(markdown || '').replace(SPEC_FENCE_RE, ''));
}

export function hasComputation(markdown) {
    const text = stripSpecFences(markdown);
    if (!/\d/.test(text)) return false;
    const equations = (text.match(/=\s*[^=\n]{0,30}?\d/g) || []).length;
    const arithmetic = (text.match(/\d\s*(?:\\times|\\cdot|\\div|\\frac|[*/×÷^])\s*\\?\{?\s*\d/g) || []).length;
    return equations + arithmetic >= 2;
}

/**
 * Recompute a lesson segment's own arithmetic, and check it against what earlier
 * parts of the same topic established.
 *
 * THE HOLE THIS FILLS. Everything else here checks questions or visuals. Nothing
 * checked the worked examples in the teaching itself — which is where most of a
 * lesson's numbers live, and where being wrong is worst, because a question at
 * least gets a second opinion on its key before it is served. A live card taught
 * "L = λ/4 + λ/2 + λ/2 = 3λ/4" (it is 5λ/4), concluded the wrong harmonic from
 * it, and contradicted a correct derivation the same topic had given two cards
 * earlier. Every gate passed it: the fences were closed, the language was right,
 * the diagram beside it was accurate, and no model was ever asked to add it up.
 *
 * This is the D-021 "function, not values" discipline applied where it was
 * missing. Charts get it from the renderer (the engine computes the points) and
 * open-question keys get it from the verifier's audit branch; prose got nothing,
 * because prose is exactly where a model hand-computes.
 *
 * Deliberately NARROW. It judges arithmetic, internal contradiction and conflict
 * with earlier parts — never style, coverage, difficulty or pedagogy. A general
 * critic would find something wrong with every draft and the retry budget would
 * be spent rewriting good lessons.
 *
 * Fails OPEN: an audit that cannot run is not evidence of a bad lesson.
 * Returns { ok, reason, quote }.
 */
export async function auditLessonMath(nodeTitle, partTitle, markdown, { priorParts = [], signal } = {}) {
    if (!hasComputation(markdown)) return { ok: true, reason: 'nothing to compute' };
    try {
        const { system, user } = AI_PROMPTS.feed_lesson_audit(
            nodeTitle, partTitle, stripSpecFences(markdown), priorParts,
        );
        const resp = await generateResponse(user, system, [], { temperature: 0.1, signal });
        const parsed = parseObject(resp);
        if (!parsed || typeof parsed.verdict !== 'string') {
            return { ok: true, reason: 'auditor returned nothing usable' };
        }
        if (parsed.verdict.toLowerCase() !== 'broken') return { ok: true, reason: 'audited' };
        return {
            ok: false,
            reason: String(parsed.reason || 'a calculation in the segment does not check out').slice(0, 240),
            quote: String(parsed.quote || '').slice(0, 240),
        };
    } catch (err) {
        if (err?.name === 'AbortError') throw err;
        return { ok: true, reason: `auditor unavailable (${err.message})` };
    }
}

/** Fenced visual blocks worth checking for semantic honesty, with surrounding prose. */
const CHECKABLE_VISUALS = new Set(['plot', 'vega-lite', 'animation', 'mermaid']);
const VISUAL_PROSE_CHARS = 1200;

export function extractCheckableVisuals(markdown) {
    const text = String(markdown || '');
    const out = [];
    const re = /^```([\w-]+)\n([\s\S]*?)^```/gm;
    let m;
    while ((m = re.exec(text)) !== null) {
        const kind = m[1].toLowerCase();
        if (!CHECKABLE_VISUALS.has(kind)) continue;
        const before = text.slice(Math.max(0, m.index - VISUAL_PROSE_CHARS), m.index);
        const after = text.slice(re.lastIndex, re.lastIndex + 400);
        out.push({ kind, spec: m[2], block: m[0], prose: `${before}\n[VISUAL HERE]\n${after}`.trim() });
    }
    return out;
}

/**
 * An ```animation whose SVG carries no SMIL animation element at all. Purely
 * mechanical and worth its own check because the failure is invisible: the
 * scene renders, perfectly still, and every syntactic sanitizer passes it.
 */
export function isStaticAnimation(kind, spec) {
    return kind === 'animation' && !/<animate(Transform|Motion)?\b/i.test(spec);
}

function parseObject(resp) {
    const match = String(resp || '').match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
        return parseJsonWithRepair(escapeLatexBackslashes(match[0]));
    } catch {
        return null;
    }
}

/**
 * Loose equality for comparing two answers to the same question.
 *
 * "Loose" has to mean tolerant of PACKAGING — `$525$ Hz`, "The answer is
 * 525 Hz", a stray period — and nothing else, because this one boolean is the
 * entire verdict of the answer-key verifier. The original was a lowercase
 * `[^a-z0-9À-ɏ]` squash plus a raw `includes`, and it was wrong in both
 * directions at once:
 *
 *  - FAILS OPEN on numbers. Raw substring containment made "5 Hz" agree with
 *    "525 Hz", "15 Hz" with "515 Hz", "2" with "12" — and stripping the minus
 *    sign made "x = 3" agree with "x = -3". Those are the exact option sets a
 *    maths or physics question is built from, so the one gate that exists to
 *    veto a wrong key was quietly rubber-stamping it.
 *  - FAILS CLOSED on script. `À-ɏ` is Latin only, so every Japanese, Cyrillic,
 *    Greek, CJK, Arabic or Hebrew answer normalized to the empty string and was
 *    reported as "answer key disputed" — the feed then dropped the question and
 *    recorded a skip reason. A kana or Russian project could not serve a
 *    multiple-choice question whose answer is written in its own script.
 *
 * So: tokenize instead of squashing (Unicode letters, and numbers WITH their
 * sign and decimals intact), and allow containment only on whole-token
 * boundaries so packaging is forgiven while a different number never is.
 */
function tokenizeAnswer(s) {
    return String(s ?? '')
        .toLowerCase()
        .replace(/\$/g, '')
        // Unicode minus / en-dash / figure-dash all mean "negative" here.
        .replace(/[−‒–]/g, '-')
        // Decimal comma is the norm in most of Europe (this app's own material
        // is Dutch), and the verifier writes its answer free-hand while the key
        // is an authored option — so "1,5" and "1.5" must not read as different
        // numbers. Only between digits, so a list ("2, 3, 5") is untouched.
        .replace(/(\p{N}),(?=\p{N})/gu, '$1.')
        // A minus only belongs to the number when it PREFIXES one: "x - 3" is a
        // subtraction, "-3" is a negative quantity.
        .match(/\p{L}+|(?<![\p{L}\p{N}])-?\p{N}+(?:[.,]\p{N}+)*/gu) || [];
}

export function sameAnswer(a, b) {
    const x = tokenizeAnswer(a);
    const y = tokenizeAnswer(b);
    if (!x.length || !y.length) return false;
    const [short, long] = x.length <= y.length ? [x, y] : [y, x];
    // Contiguous token-subsequence containment: "525 hz" is found inside
    // "the answer is 525 hz", but "5 hz" is not inside "525 hz".
    for (let i = 0; i + short.length <= long.length; i++) {
        if (short.every((tok, j) => tok === long[i + j])) return true;
    }
    return false;
}

/**
 * Independent second opinion on a question's answer key.
 *
 * The verifier never sees the intended answer — it solves the question cold, so
 * agreement is real evidence rather than assent. Returns
 * { ok, available, reason }: ok=false means DO NOT SERVE this question.
 *
 * `available` is the load-bearing half, and it is separate from `ok` on purpose.
 * An unreachable model — or one that answered with nothing parseable — is NOT
 * evidence that a question is fine, so this returns ok=true (the interactive
 * paths must degrade toward serving, like every other model-dependent gate here)
 * together with available=false. Any caller that reports a VERDICT over a batch
 * must refuse to call that batch clean when the flag is down. Written after a run
 * of the offline audit announced "0 unsound out of 10" off the back of ten failed
 * requests: the same shape as the transfer sweep that withdrew every head start
 * when it could not see the topic space, and the vision probe that cached a
 * failure as a definitive "no".
 *
 * Only closed questions (multiple choice, true/false) are vetoed on an ANSWER
 * mismatch — an open question has many right phrasings, so a differently-worded
 * answer is not evidence of a bad key. Open questions are instead AUDITED (the
 * prompt switches mode): the verifier recomputes the model answer's arithmetic
 * and checks it against its own explanation, and a fault there comes back as
 * verdict "broken", which is rejected below like any other.
 */
export async function verifyQuestion(nodeTitle, question, { signal } = {}) {
    try {
        const { system, user } = AI_PROMPTS.feed_question_verify(nodeTitle, question);
        const resp = await generateResponse(user, system, [], { temperature: 0.1, signal });
        const parsed = parseObject(resp);
        if (!parsed || typeof parsed.verdict !== 'string') {
            // A verifier that produced nothing usable is not evidence of a bad
            // question. Serve it — the mechanical gates already passed.
            return { ok: true, available: false, reason: 'verifier returned nothing usable' };
        }
        const reason = String(parsed.reason || '').slice(0, 200);
        if (parsed.verdict.toLowerCase() === 'broken') {
            return { ok: false, available: true, reason: reason || 'verifier called the question broken' };
        }
        // How many options the verifier could rule out WITHOUT knowing the
        // subject. Reported, never vetoed: it is a weakness (the item measures
        // less than it claims), and a skipped question measures nothing at all.
        // Collected here because the verifier has already had to weigh every
        // option in order to answer, so it costs one extra JSON field rather
        // than another call — and asking AFTER the cold solve keeps the primary
        // job (what is the answer) uncontaminated by a critique framing.
        const eliminable = Number.isFinite(parsed.eliminable) ? Math.max(0, Math.trunc(parsed.eliminable)) : null;

        // An open answer and a reference solution are AUDITED, never solved
        // cold: many right phrasings, many right programs.
        if (question.type === 'short_answer') return { ok: true, available: true, reason: 'open question, key not vetoed', eliminable };
        if (question.type === 'code') return { ok: true, available: true, reason: 'reference solution audited, not vetoed', eliminable };
        // An ordering IS solvable cold, and it is exactly the closed format
        // where a disputed key must veto: the verifier orders the same items
        // and the two orders must agree item for item.
        if (question.type === 'sequence') {
            const theirs = Array.isArray(parsed.answer) ? parsed.answer.map(s => String(s).trim()) : null;
            let key = [];
            try { key = JSON.parse(String(question.correct_answer)); } catch { /* defects already caught it */ }
            const agreesInOrder = !!theirs && theirs.length === key.length
                && theirs.every((item, i) => sameOption(item, key[i]));
            if (!agreesInOrder) {
                return { ok: false, available: true, reason: `order disputed (verifier put "${String(theirs?.[0] ?? parsed.answer).slice(0, 60)}" first)`, eliminable };
            }
            return { ok: true, available: true, reason: 'verified', eliminable };
        }
        // True/false is compared strictly. The verifier is told to answer with
        // exactly "True" or "False", and the key is already normalized to one of
        // those — so containment buys nothing here and costs everything: "it is
        // not true" contains "true", and a negation reading as agreement is the
        // one mistake a two-option question cannot survive.
        const agrees = question.type === 'true_false'
            ? String(parsed.answer ?? '').trim().toLowerCase() === String(question.correct_answer).trim().toLowerCase()
            : sameAnswer(parsed.answer, question.correct_answer);
        if (!agrees) {
            return { ok: false, available: true, reason: `answer key disputed (verifier chose "${String(parsed.answer).slice(0, 80)}")`, eliminable };
        }
        return { ok: true, available: true, reason: 'verified', eliminable };
    } catch (err) {
        if (err?.name === 'AbortError') throw err;
        return { ok: true, available: false, reason: `verifier unavailable (${err.message})`, eliminable: null };
    }
}

// Two giveaway distractors put a four-option item's real guess floor near 0.5
// while BKT still credits it at 0.25. One is ordinary question writing.
export const MAX_ELIMINABLE_OPTIONS = 1;

/**
 * Check a lesson's visuals against the prose around them.
 * Returns { markdown, removed: [{kind, reason}], disputes: [{kind, reason}] }.
 *
 * The check finds a DISAGREEMENT between a spec and the prose beside it. Which
 * half is wrong is a separate question, and the original design answered it by
 * assumption — always the visual — which was right often enough to be worth
 * shipping and wrong in the case that matters most.
 *
 * Removal is still correct when the SPEC is at fault: the repair loop already
 * exists for specs that fail to RENDER, and one that renders beautifully while
 * teaching something false is not a rendering problem — asking the same model to
 * fix its own misconception tends to produce a second confident wrong picture. A
 * lesson missing a visual still teaches.
 *
 * But a live card had it the other way round: the prose miscounted a standing
 * wave's segments and the mermaid diagram beside it was exactly right. Removing
 * the diagram there would have deleted the accurate half and shipped the false
 * half with its contradicting evidence gone — the gate actively making the card
 * worse. So the checker now reports WHICH side it believes (`text-wrong`), those
 * come back as `disputes`, the visual is left alone, and the caller rewrites the
 * prose instead. An unrecognised verdict counts as ok, so an older or smaller
 * model that ignores the third option degrades to the previous behaviour.
 */
export async function vetLessonVisuals(markdown, partTitle, { signal } = {}) {
    let text = String(markdown || '');
    const removed = [];
    const disputes = [];
    for (const v of extractCheckableVisuals(text)) {
        let reason = null;
        if (isStaticAnimation(v.kind, v.spec)) {
            reason = 'nothing in the scene actually moves';
        } else {
            try {
                const { system, user } = AI_PROMPTS.feed_visual_check(partTitle, v.prose, v.kind, v.spec);
                const resp = await generateResponse(user, system, [], { temperature: 0.1, signal });
                const parsed = parseObject(resp);
                const verdict = String(parsed?.verdict || '').toLowerCase();
                if (verdict === 'text-wrong' || verdict === 'text_wrong') {
                    disputes.push({
                        kind: v.kind,
                        reason: String(parsed.reason || 'the prose contradicts a correct visual').slice(0, 200),
                    });
                    continue;
                }
                if (verdict === 'wrong') {
                    reason = String(parsed.reason || 'the visual contradicts the text').slice(0, 200);
                }
            } catch (err) {
                if (err?.name === 'AbortError') throw err;
                // Unavailable checker = keep the visual. Same posture as the
                // rest of the AI layer: an enhancement, never a dependency.
            }
        }
        if (reason) {
            text = text.replace(v.block, '').replace(/\n{3,}/g, '\n\n');
            removed.push({ kind: v.kind, reason });
        }
    }
    return { markdown: text.trim(), removed, disputes };
}
