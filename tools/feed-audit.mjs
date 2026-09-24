/**
 * Audit the cached learning feed for the defect classes the generator is built
 * to prevent. Read-only; safe to run against a live DB.
 *
 *   node tools/feed-audit.mjs            # all cached topics
 *   node tools/feed-audit.mjs 11313 608  # named topics only
 *   node tools/feed-audit.mjs --verbose  # name every offending item
 *
 * Exists because "the feed looks good" is not a measurement. Every check below
 * corresponds to a defect class the generator is built to prevent, so the
 * audit measures the cache against the standard rather than against a model's
 * good day.
 *
 * Findings are advisory: this is a quality readout, not a gate, and the exit
 * code is always 0 unless a check itself failed to run.
 */
import Database from 'better-sqlite3';
import { sameOption, keyEchoesStem, keyIsLengthOutlier, isShapeOnlyOption } from '../server/questionOptions.js';
import { linearCombinationFaults } from '../server/arithmetic.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveDbPath() {
    return path.join(__dirname, '..', 'server', 'terramentor.db');
}

const db = new Database(resolveDbPath(), { readonly: true });
const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const only = args.filter(a => /^\d+$/.test(a)).map(Number);

const SPEC_FENCE_RE = /^```(mermaid|vega-lite|vega|plot|animation|p5|widget|drill|smiles)\b/gm;
const SPEC_BLOCK_RE = /^```(?:mermaid|vega-lite|vega|plot|animation|p5|widget|drill|smiles|svg)\b[\s\S]*?^```/gm;
// The second alternation is the same self-certification written as a
// subordinate clause ("Mastering this scan ensures you can…"), which the
// generator's own anchored pattern could not see until it grew a `certify` case.
const CLOSER_RE = /(you can now|you are now|you should now be able|you now (?:understand|know|have)|now you can|with this,? you)|((?:ensures?|means|allows?|enables?|equips?|guarantees?)\s+(?:that\s+)?you\b)/i;
// A lesson that invented its own index and then has to translate out of it —
// the shape that produced a wrong harmonic from a correct diagram.
const NOTATION_DRIFT_RE = /\b(?:index|counter|label|numbering)\b[^.]{0,60}\bbut the (?:actual|real|true|standard)\b/i;
const META_REF_RE = /\b(the lesson|the segment|this segment|the text (?:above|states)|according to the material)\b/i;
const FOREIGN = [
    ['Han', /[一-鿿]/], ['Kana', /[぀-ヿ]/], ['Hangul', /[가-힯]/],
    ['Cyrillic', /[Ѐ-ӿ]/], ['Arabic', /[؀-ۿ]/],
];

const rows = db.prepare(`
    SELECT fi.id, fi.node_id, fi.kind, fi.seq, fi.content, fi.meta,
           n.title AS node_title, n.project_id, p.name AS project
    FROM feed_items fi
    JOIN nodes n ON n.id = fi.node_id
    JOIN projects p ON p.id = n.project_id
    ORDER BY fi.node_id, fi.seq
`).all().filter(r => only.length === 0 || only.includes(r.node_id));

/** Scripts legitimately used anywhere in a project (a Japanese course owns kana). */
const scriptRef = new Map();
function projectScripts(projectId) {
    if (!scriptRef.has(projectId)) {
        const text = db.prepare(
            'SELECT title, description, notes FROM nodes WHERE project_id = ? LIMIT 2000',
        ).all(projectId).flatMap(n => [n.title, n.description, n.notes]).filter(Boolean).join(' ');
        scriptRef.set(projectId, text);
    }
    return scriptRef.get(projectId);
}

const findings = [];
const add = (severity, check, row, detail) => findings.push({
    severity, check, detail,
    where: `${row.node_id} ${row.kind}${row.seq ? ` seq=${row.seq}` : ''} — ${row.node_title}`,
});

const lessons = rows.filter(r => r.kind === 'lesson');
const questions = rows.filter(r => r.kind === 'question');
const plans = rows.filter(r => r.kind === 'plan');
const practice = rows.filter(r => r.kind === 'practice');

// ---- lessons -------------------------------------------------------------
const partCounts = [];
let unaudited = 0;
for (const l of lessons) {
    const text = String(l.content || '');
    const lessonMeta = (() => { try { return JSON.parse(l.meta || '{}'); } catch { return {}; } })();

    const fences = text.match(/^```/gm) || [];
    if (fences.length % 2 !== 0) add('error', 'unclosed-fence', l, 'a fenced block is never closed');

    // Arithmetic the lesson states and gets wrong. Recomputed here rather than
    // trusted from meta, so rows cached BEFORE the gate existed are covered —
    // feed_items is a cache, and a prompt or gate change never improves what is
    // already in it.
    for (const fault of linearCombinationFaults(text.replace(SPEC_BLOCK_RE, ''))) {
        add('error', 'arithmetic-wrong', l, `"${fault.statement}" — ${fault.expected}`);
    }

    if (NOTATION_DRIFT_RE.test(text)) {
        add('warn', 'notation-drift', l,
            'the lesson invents its own index and then translates out of it — the learner inherits both conventions');
    }

    // A gate ran, rejected every draft, and the last one was served anyway.
    if (lessonMeta.unresolvedFault) {
        add('error', 'unresolved-fault', l,
            `served with a standing ${lessonMeta.unresolvedFault.stage} fault: ${lessonMeta.unresolvedFault.reason}`);
    }
    // Written before the numeric audit existed, so its worked examples have
    // never been read by anything. Counted, not reported per-item: it is a
    // backlog measurement, and every one of them is a feed-regen candidate.
    if (!lessonMeta.unresolvedFault && !lessonMeta.audited && /\d/.test(text)) unaudited++;

    for (const [name, re] of FOREIGN) {
        if (re.test(text) && !re.test(projectScripts(l.project_id))) {
            add('error', 'script-leak', l, `${name} characters in a project that never uses them`);
        }
    }

    const tail = text.slice(-350);
    if (CLOSER_RE.test(tail)) add('warn', 'self-certifying-closer', l, 'ends by certifying the learner');

    if (text.trim().length < 400) add('warn', 'thin-lesson', l, `${text.trim().length} chars`);
}

// Example drift inside one topic.
//
// Re-showing an earlier class in a later part is CONTINUATION and is exactly
// what the running-example rule asks for, so repetition alone is not a defect.
// The defect is the same example coming back CHANGED — the signature of a part
// that regenerated the example from scratch instead of building on it (the
// original case: a Move() body that decremented the battery by 5 in one part
// and by 10 in the next, in a class presented as the same one).
const byNode = new Map();
for (const l of lessons) {
    if (!byNode.has(l.node_id)) byNode.set(l.node_id, []);
    byNode.get(l.node_id).push(l);
}

/**
 * Body of every class/interface/struct declaration in REAL code, keyed by name.
 *
 * Spec fences are stripped first: a mermaid `classDiagram` writes `class Robot {
 * +string Name }`, which is the same shape as a C# declaration and would
 * otherwise be compared against the actual source and always look different.
 */
function declarations(markdown) {
    const text = String(markdown).replace(
        /^```(?:mermaid|vega-lite|vega|plot|animation|p5|widget|drill|smiles)\b[\s\S]*?^```/gm, '',
    );
    const out = new Map();
    const re = /\b(?:class|interface|struct)\s+([A-Z][A-Za-z0-9_]*)[^{]*\{/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        // Walk braces from the opening one to find the matching close.
        let depth = 1;
        let i = re.lastIndex;
        while (i < text.length && depth > 0) {
            if (text[i] === '{') depth++;
            else if (text[i] === '}') depth--;
            i++;
        }
        // Normalise away whitespace and comments; only real content differences matter.
        const body = text.slice(re.lastIndex, i - 1)
            .replace(/\/\/[^\n]*/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        if (!out.has(m[1])) out.set(m[1], body);
    }
    return out;
}

/**
 * Method/constructor bodies inside a class body, keyed "Class.Method".
 *
 * Only METHOD bodies are compared. A field's modifier changing between parts is
 * usually the lesson's whole point (a topic on private vs protected shows the
 * same class with one keyword swapped, which is ideal teaching), and adding a
 * member later is normal development. Behaviour silently changing under the same
 * name is the thing that cannot be intentional.
 */
function methodBodies(className, classBody) {
    const out = new Map();
    const re = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*\{/g;
    let m;
    while ((m = re.exec(classBody)) !== null) {
        let depth = 1;
        let i = re.lastIndex;
        while (i < classBody.length && depth > 0) {
            if (classBody[i] === '{') depth++;
            else if (classBody[i] === '}') depth--;
            i++;
        }
        const body = classBody.slice(re.lastIndex, i - 1).replace(/\s+/g, ' ').trim();
        if (body) out.set(`${className}.${m[1]}`, body);
    }
    return out;
}

for (const [, group] of byNode) {
    const seen = new Map(); // "Class.Method" -> { body, part }
    for (const l of group) {
        const part = (() => { try { return JSON.parse(l.meta || '{}').partIndex; } catch { return null; } })()
            ?? Math.ceil(l.seq / 2);
        for (const [className, classBody] of declarations(String(l.content))) {
            for (const [key, body] of methodBodies(className, classBody)) {
                const prior = seen.get(key);
                if (!prior) { seen.set(key, { body, part }); continue; }
                if (prior.body !== body) {
                    add('warn', 'example-drift', l,
                        `${key}() has a different body in part ${prior.part} and part ${part} — ` +
                        'the later part rewrote the running example instead of continuing it');
                }
            }
        }
    }
}

// ---- plans ---------------------------------------------------------------
for (const p of plans) {
    let parts = [];
    try { parts = JSON.parse(p.content).parts || []; } catch { /* corrupt */ }
    partCounts.push(parts.length);
    if (parts.length === 0) add('error', 'corrupt-plan', p, 'no parsable parts');
    const meta = (() => { try { return JSON.parse(p.meta || '{}'); } catch { return {}; } })();
    if (Array.isArray(meta.skippedQ) && meta.skippedQ.length) {
        add('warn', 'missing-question', p,
            `parts ${meta.skippedQ.join(', ')} have no question (${JSON.stringify(meta.skippedQReason || 'reason not recorded')})`);
    }
}

// ---- questions -----------------------------------------------------------
const typeCounts = {};
let verified = 0;
let visualStems = 0;
for (const q of questions) {
    let parsed;
    try { parsed = JSON.parse(q.content); } catch { add('error', 'corrupt-question', q, 'unparsable'); continue; }
    typeCounts[parsed.type] = (typeCounts[parsed.type] || 0) + 1;

    const meta = (() => { try { return JSON.parse(q.meta || '{}'); } catch { return {}; } })();
    if (meta.verified) verified++;
    else add('warn', 'unverified-key', q, 'answer key never passed an independent check');

    if (/```/.test(parsed.question || '')) visualStems++;

    if (META_REF_RE.test(parsed.question || '')) {
        add('error', 'tests-the-text', q, 'the question refers to the lesson itself, so it tests reading not understanding');
    }
    if (META_REF_RE.test(parsed.explanation || '')) {
        add('warn', 'explanation-cites-text', q, 'the explanation appeals to the lesson rather than to the subject');
    }
    if (parsed.type === 'true_false' && /\?\s*$/.test(String(parsed.question || '').trim())) {
        add('warn', 'tf-phrased-as-question', q, 'a true/false stem must be a statement, not a question');
    }
    // On a missed answer the explanation IS the teaching, so an empty one turns
    // the card into a bare "Not quite".
    if (!String(parsed.explanation || '').trim()) {
        add('error', 'no-explanation', q, 'a wrong answer is marked wrong and never explained');
    }

    if (Array.isArray(meta.weaknesses) && meta.weaknesses.length) {
        add('warn', 'weak-question-served', q, meta.weaknesses.join('; '));
    }

    if (parsed.type === 'multiple_choice') {
        const opts = parsed.options || [];

        // Ways a learner scores without understanding. Recomputed here, not read
        // from meta, so questions cached before these checks existed are covered.
        if (keyEchoesStem(parsed.question, opts, parsed.correct_answer)) {
            add('warn', 'key-echoes-stem', q,
                'the key repeats a number the stem states and no distractor does — pickable without understanding');
        }
        if (keyIsLengthOutlier(opts, parsed.correct_answer)) {
            add('warn', 'key-length-outlier', q, 'the correct option is far longer than every distractor');
        }
        const shapeOnly = opts.filter(isShapeOnlyOption);
        if (shapeOnly.length) {
            add('warn', 'shape-only-option', q, `"${shapeOnly[0]}" is meaningless once the options are shuffled`);
        }

        // Compared by VALUE, not by string: "$x = 1.5$" and "$x = \frac{3}{2}$"
        // are one distractor wearing two hats, and a plain string set sees two.
        for (let i = 0; i < opts.length; i++) {
            for (let j = i + 1; j < opts.length; j++) {
                if (sameOption(opts[i], opts[j])) {
                    add('error', 'duplicate-options', q, `options ${i + 1} and ${j + 1} are the same value ("${opts[i]}" / "${opts[j]}")`);
                }
            }
        }
        if (!opts.includes(parsed.correct_answer)) {
            add('error', 'key-not-an-option', q, 'correct_answer matches no option');
        }
    }
}

// Cap: how many true/false per topic (guess floor 50%, so more than one is a
// measurement problem, not a style one).
for (const [nodeId, group] of byNode) {
    const tf = questions.filter(q => q.node_id === nodeId && (() => {
        try { return JSON.parse(q.content).type === 'true_false'; } catch { return false; }
    })());
    if (tf.length > 1) {
        add('warn', 'true-false-overused', group[0], `${tf.length} true/false questions in one topic`);
    }
}

// ---- report --------------------------------------------------------------
const bySeverity = { error: 0, warn: 0 };
const byCheck = {};
for (const f of findings) {
    bySeverity[f.severity]++;
    byCheck[f.check] = (byCheck[f.check] || 0) + 1;
}

const avg = (xs) => (xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
const visualFences = lessons.reduce((n, l) => n + ((String(l.content).match(SPEC_FENCE_RE) || []).length), 0);

console.log(`FEED AUDIT — ${plans.length} topics, ${lessons.length} lessons, ${questions.length} questions, ${practice.length} paper exercises\n`);
console.log(`  parts per topic      ${partCounts.length ? `${Math.min(...partCounts)}–${Math.max(...partCounts)} (avg ${avg(partCounts).toFixed(1)})` : '—'}`);
console.log(`  lesson length        avg ${Math.round(avg(lessons.map(l => l.content.length)))} chars`);
console.log(`  visuals              ${visualFences} spec blocks across ${lessons.length} lessons`);
console.log(`  question types       ${Object.entries(typeCounts).map(([k, v]) => `${k} ${v}`).join(', ') || '—'}`);
console.log(`  true/false share     ${questions.length ? Math.round(100 * (typeCounts.true_false || 0) / questions.length) : 0}%`);
console.log(`  keys verified        ${verified}/${questions.length}`);
console.log(`  visual question stems ${visualStems}`);
console.log(`  never numerically audited  ${unaudited}/${lessons.length} lessons with numbers (re-author with tools/feed-regen.mjs)`);
console.log(`\n  findings: ${bySeverity.error} error, ${bySeverity.warn} warn`);
for (const [check, n] of Object.entries(byCheck).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(3)}  ${check}`);
}
if (verbose && findings.length) {
    console.log('');
    for (const f of findings.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1))) {
        console.log(`  [${f.severity}] ${f.check} · ${f.where}\n         ${f.detail}`);
    }
}
