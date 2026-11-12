// A mastery check as ONE form the host asks its user to fill in (MCP
// elicitation, form mode), for a host that takes input from its user and draws
// no views: a terminal agent. The questions come from the app's own draw with
// no key (`publicQuestion`, server/agentSittings.js), the answers go back to
// the app's own grading, and the check counts as any other: it is the
// learner's answers, not the model's.
//
// A form field is a flat string, a choice from a list, or a number: no field
// nests and none is multi-line. So:
//   - a choice and a true/false are a list of the question's own options;
//   - an ordering is one field per position, each a list of its items;
//   - an assembly is one field per gap, each a list of its pieces;
//   - a number, a gap word and a short answer are a line of text;
//   - a code question is never drawn into a form (`startCheck({ form })`).
// Fields are `q<n>`, or `q<n>_<k>` for a question's k-th position or gap, and
// none is required: a blank counts as wrong, as an untouched input does in the
// app.

const GAP = /_{3,}/;
const FIELD = /^q(\d+)(?:_(\d+))?$/;
const LINE_CHARS = 2000;

/**
 * Whether a client's capabilities take a form: `elicitation: {}` is form
 * mode by the spec's own default, `{ url: {} }` alone is a client that only
 * opens links.
 */
export function takesForm(capabilities) {
    const el = capabilities?.elicitation;
    return !!el && typeof el === 'object' && (!!el.form || !el.url);
}

/** How much of a question's text the second and later fields of a split question repeat. */
const PART_STEM_CHARS = 80;
/** A list's non-empty strings, in order, repeats kept; `unique` keeps each once. */
const listed = (list) => (Array.isArray(list) ? list : []).filter(x => typeof x === 'string' && x);
const unique = (list) => [...new Set(listed(list))];
const gapsOf = (q) => Math.max(0, String(q.template ?? '').split(GAP).length - 1);
/** An assembly's template with its gaps numbered, as the fields name them. */
const numberedTemplate = (q) => String(q.template ?? '').split(GAP).map((part, i, all) => part + (i < all.length - 1 ? `[${i + 1}]` : '')).join('');

/**
 * The form's fields for the check's questions (`{ n, type, question, ... }`
 * as `check/questions` serves them). A question none of whose fields can be
 * drawn (an ordering with no items, an assembly with no pieces) is still
 * asked, as a line of text, so the numbering matches the check.
 */
export function formSchema(questions) {
    const properties = {};
    for (const q of questions) {
        const head = `${q.n}. ${q.question}`;
        // A question asked over several fields names itself on each, so a
        // field read alone still says which question and which part it is.
        const stem = String(q.question ?? '');
        const short = stem.length > PART_STEM_CHARS ? `${stem.slice(0, PART_STEM_CHARS - 1)}…` : stem;
        const part = (word, k, of) => `${k === 0 ? head : `${q.n}. ${short}`} (${word} ${k + 1} of ${of})`;
        const items = unique(q.items);
        const tokens = unique(q.tokens);
        if (q.type === 'multiple_choice' && unique(q.options).length) {
            properties[`q${q.n}`] = { type: 'string', title: head, enum: unique(q.options) };
        } else if (q.type === 'true_false') {
            properties[`q${q.n}`] = { type: 'string', title: head, enum: ['True', 'False'] };
        } else if (q.type === 'sequence' && items.length) {
            // One field per item served, the choices each distinct item once:
            // an item listed twice has two places in the order.
            listed(q.items).forEach((_, k, served) => {
                properties[`q${q.n}_${k + 1}`] = {
                    type: 'string', title: part('place', k, served.length),
                    description: `Place ${k + 1} of ${served.length}, in the order the question asks for.`, enum: items,
                };
            });
        } else if (q.type === 'assemble' && tokens.length && gapsOf(q)) {
            for (let k = 0; k < gapsOf(q); k++) {
                properties[`q${q.n}_${k + 1}`] = {
                    type: 'string', title: part('gap', k, gapsOf(q)),
                    description: `Gap [${k + 1}] in: ${numberedTemplate(q)}`, enum: tokens,
                };
            }
        } else if (q.type === 'numeric') {
            properties[`q${q.n}`] = { type: 'string', title: q.unit ? `${head} (in ${q.unit})` : head, description: 'A number.' };
        } else {
            properties[`q${q.n}`] = { type: 'string', title: head };
        }
    }
    return { type: 'object', properties };
}

/** The form's message: what it is and how it counts. Names no answer. */
export function formMessage({ title, count, passPct }) {
    return `Mastery check on "${title}": ${count} question${count === 1 ? '' : 's'}. Terramentor grades the answers and records `
        + `the result, which counts as the topic's mastery check; ${passPct}% passes. Leave a question blank if you do not know it: `
        + 'a blank counts as wrong. Closing or declining the form records nothing. Once the answers are graded, the assistant '
        + 'is told the score and each question missed, with the answer given and the right one.';
}

/**
 * The form's content as the check's answers, one per question in order, each
 * encoded as the app's own input encodes it (an ordering and an assembly as
 * JSON); null for a question left blank.
 */
export function formAnswers(questions, content) {
    const values = {};
    for (const [key, value] of Object.entries(content && typeof content === 'object' ? content : {})) {
        const m = FIELD.exec(key);
        if (!m || typeof value !== 'string' || !value.trim()) continue;
        (values[m[1]] ??= {})[m[2] ?? ''] = value.slice(0, LINE_CHARS);
    }
    return questions.map((q) => {
        const got = values[q.n] || {};
        if (q.type === 'sequence' && unique(q.items).length) {
            const places = listed(q.items).map((_, k) => got[k + 1] ?? '');
            return places.some(Boolean) ? JSON.stringify(places) : null;
        }
        if (q.type === 'assemble' && unique(q.tokens).length && gapsOf(q)) {
            const pieces = Array.from({ length: gapsOf(q) }, (_, k) => got[k + 1] ?? null);
            return pieces.some(p => p != null) ? JSON.stringify(pieces) : null;
        }
        return got[''] ?? null;
    });
}
