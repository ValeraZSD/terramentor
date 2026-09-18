/**
 * Audit — and optionally repair — the questions already stored in `quizzes`.
 *
 * Why this is needed on top of the generation-time check in `vetQuiz`: the Boss
 * Fight REUSES saved quizzes. `MasteryGateModal` only generates when a node has
 * no saved questions at all, so a question authored once is served on every
 * retake, forever, and a gate added to the generator never reaches a single row
 * that is already in the database. Nothing re-authors them on its own.
 *
 * The defect this was written for is a stem with more than one defensible
 * answer — "you hear 5 beats against a 520 Hz reference, what is your
 * frequency?" is answered equally by 515 Hz and 525 Hz, and a live Boss Fight
 * offered both with one of them keyed. The verifier is not told the key, so it
 * catches this the same way it catches a wrong one.
 *
 * Usage (the server must NOT be running — this writes to the same SQLite file):
 *   node tools/quiz-audit.mjs                     # audit everything, change nothing
 *   node tools/quiz-audit.mjs --repair            # rewrite what fails, drop what can't be fixed
 *   node tools/quiz-audit.mjs --node 11316        # one topic
 *   node tools/quiz-audit.mjs --quiz 122          # one saved quiz
 *   node tools/quiz-audit.mjs --limit 40          # first N questions (audit a sample)
 *   node tools/quiz-audit.mjs --resume            # skip questions already passed in a previous run
 *   node tools/quiz-audit.mjs --wait 180          # park up to 3h waiting for the model's turn
 *   node tools/quiz-audit.mjs --no-wait           # fail fast instead of waiting
 *
 * WAITING IS THE NORMAL CASE on a single-GPU box: only one local model instance
 * fits in memory, so while another consumer (Ollama, the app itself) holds one,
 * llama-swap's llama-server exits at startup instead of queueing. The sweep parks
 * and retries the same question rather than abandoning an hour of finished work.
 *
 * MODEL: defaults to the LOCAL llama-swap endpoint, not whatever the app is
 * configured to use, because this makes one call per question (and two or three
 * per repair) across the whole library — a metered cloud model should not be
 * spent on a background sweep. Override with AI_PROVIDER / AI_BASE_URL / AI_MODEL.
 *
 * Attempts already recorded against a quiz are never touched: repairing an item
 * changes what future retakes ask, not what the learner has already proved.
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag, fallback = null) => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const REPAIR = has('--repair');
const RESUME = has('--resume');
const ONLY_NODE = valueOf('--node') ? Number(valueOf('--node')) : null;
const ONLY_QUIZ = valueOf('--quiz') ? Number(valueOf('--quiz')) : null;
const LIMIT = valueOf('--limit') ? Number(valueOf('--limit')) : Infinity;

// Set BEFORE the server modules load, so getAISettings() reads them. Only fills
// gaps — an explicitly exported AI_* variable still wins.
process.env.AI_PROVIDER ||= 'openai';
process.env.AI_BASE_URL ||= 'http://127.0.0.1:8888/v1';
process.env.AI_MODEL ||= 'qwen3.6-35b-a3b';

const B = new URL('../server/', import.meta.url).href;
const { default: db } = await import(B + 'database.js');
const { verifyQuestion, questionDefects } = await import(B + 'feedQuality.js');
const { AI_PROMPTS, generateResponse, getAISettings } = await import(B + 'ai.js');
const { parseJsonWithRepair, escapeLatexBackslashes, normalizeChoice, sanitizeExplanation } =
    await import(B + 'agentic.js');
const { getProjectLanguage } = await import(B + 'language.js');

// A sweep of hundreds of model calls gets interrupted. The ledger records which
// (quiz, question) pairs have already been judged so --resume costs nothing for
// work already done; it is a cache of verdicts, never a source of truth about
// the questions themselves.
const LEDGER = path.join(process.cwd(), 'temp', 'quiz-audit-ledger.json');
const ledger = RESUME && fs.existsSync(LEDGER)
    ? JSON.parse(fs.readFileSync(LEDGER, 'utf8'))
    : {};
const saveLedger = () => {
    fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
    fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 1));
};

const settings = getAISettings();
console.log(`model: ${settings.model} via ${settings.provider === 'openai' ? settings.baseUrl : settings.ollamaUrl}`);
console.log(REPAIR ? 'mode:  REPAIR (rewrites and drops)\n' : 'mode:  audit only (no writes)\n');

let where = '1=1';
const params = [];
if (ONLY_NODE) { where += ' AND q.node_id = ?'; params.push(ONLY_NODE); }
if (ONLY_QUIZ) { where += ' AND q.id = ?'; params.push(ONLY_QUIZ); }

const quizRows = db.prepare(`
    SELECT q.id, q.node_id, q.questions, n.title, n.project_id
    FROM quizzes q JOIN nodes n ON n.id = q.node_id
    WHERE ${where}
    ORDER BY q.id
`).all(...params);

/** Bring a repaired candidate back to the shape finalizeQuiz would have stored. */
function normalizeRepaired(candidate, original) {
    if (!candidate || typeof candidate !== 'object') return null;
    if (candidate.unfixable) return null;
    const type = candidate.type === 'true_false' ? 'true_false' : 'multiple_choice';
    const out = { ...original, ...candidate, type };
    if (type === 'multiple_choice') {
        const opts = Array.isArray(out.options)
            ? out.options.filter(o => typeof o === 'string' && o.trim())
            : [];
        if (opts.length < 3) return null;
        out.options = opts;
        if (!opts.includes(out.correct_answer)) {
            const target = normalizeChoice(out.correct_answer);
            const match = opts.find(o => normalizeChoice(o) === target);
            if (!match) return null; // key names no option — never guess one
            out.correct_answer = match;
        }
        out.explanation = sanitizeExplanation(out.explanation, out.options);
    } else {
        const norm = String(out.correct_answer ?? '').toLowerCase().trim();
        if (norm !== 'true' && norm !== 'false') return null;
        out.correct_answer = norm === 'true' ? 'True' : 'False';
        delete out.options;
        out.explanation = sanitizeExplanation(out.explanation);
    }
    const defects = questionDefects(out);
    if (defects.length) return null;
    return out;
}

function parseObject(resp) {
    const match = String(resp || '').match(/\{[\s\S]*\}/);
    if (!match) return null;
    try { return parseJsonWithRepair(escapeLatexBackslashes(match[0])); }
    catch { return null; }
}

const REPAIR_ATTEMPTS = 2;

let checked = 0, unsound = 0, repaired = 0, droppedCount = 0;
let unavailable = 0, consecutiveUnavailable = 0;
const report = [];

// A sweep that cannot reach the model must not report a clean library. The very
// first run of this tool printed "0 unsound out of 10" while every one of those
// ten requests had 500'd — verifyQuestion degrades to ok=true by design (the
// interactive paths must keep serving), so the ONLY thing separating "checked
// and sound" from "never actually checked" is its `available` flag.
const MAX_CONSECUTIVE_UNAVAILABLE = 3;

// ...but on this box "unavailable" usually means "not YET". One local model
// instance fits in memory at a time, so while another consumer holds one,
// llama-swap's llama-server dies at startup rather than queueing — the sweep's
// turn simply has not come. Giving up then throws away an hour of finished work
// over a condition that clears itself, so the default is to PARK and retry the
// same question. `available` still governs the verdict: a parked question is
// never counted as sound, and giving up is reported as a stall, not a clean run.
const WAIT_MINUTES = has('--no-wait') ? 0 : Number(valueOf('--wait', '90'));
const BACKOFF_MS = [30_000, 60_000, 120_000, 300_000];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

for (const row of quizRows) {
    if (checked >= LIMIT) break;
    let questions;
    try { questions = JSON.parse(row.questions); } catch { continue; }
    if (!Array.isArray(questions)) continue;

    const lang = getProjectLanguage(row.project_id);
    const kept = [];
    let changed = false;

    for (const q of questions) {
        // Ghosts belong to another topic and are audited when that topic is.
        if (q?.isGhost || (q?.type !== 'multiple_choice' && q?.type !== 'true_false')) {
            kept.push(q);
            continue;
        }
        if (checked >= LIMIT) { kept.push(q); continue; }

        const key = `${row.id}:${String(q.question).slice(0, 60)}`;
        if (ledger[key] === 'ok') { kept.push(q); continue; }
        checked++;

        // Wait for the model's turn rather than skipping the question. Every
        // pass re-verifies the SAME item, so nothing is silently left unchecked.
        let check = await verifyQuestion(row.title, q, {});
        let waitedMs = 0;
        for (let back = 0; check.available === false && WAIT_MINUTES > 0; back++) {
            if (back === 0) {
                process.stdout.write('\n');
                console.log(`  .. model unavailable (${check.reason})`);
            }
            const pause = BACKOFF_MS[Math.min(back, BACKOFF_MS.length - 1)];
            if (waitedMs + pause > WAIT_MINUTES * 60_000) break;
            console.log(`     waiting ${Math.round(pause / 1000)}s for the model's turn`
                + ` (${Math.round(waitedMs / 60_000)}/${WAIT_MINUTES} min so far)`);
            await sleep(pause);
            waitedMs += pause;
            check = await verifyQuestion(row.title, q, {});
        }
        if (waitedMs && check.available !== false) {
            console.log(`     model answered after ${Math.round(waitedMs / 60_000)} min`);
        }

        if (check.available === false) {
            unavailable++;
            checked--; // it was never actually checked
            kept.push(q);
            process.stdout.write('\n');
            console.log(`  !! verifier unreachable: ${check.reason}`);
            if (++consecutiveUnavailable >= MAX_CONSECUTIVE_UNAVAILABLE) {
                console.error(`\nStopping after ${consecutiveUnavailable} consecutive unreachable checks`
                    + (WAIT_MINUTES ? ` and up to ${WAIT_MINUTES} min of waiting each` : '')
                    + '.\nWhatever was already repaired is saved, and nothing unchecked is counted as '
                    + 'sound. Re-run with --resume when the model is free.');
                saveLedger();
                process.exit(2);
            }
            continue;
        }
        consecutiveUnavailable = 0;
        if (check.ok) {
            ledger[key] = 'ok';
            kept.push(q);
            process.stdout.write('.');
            continue;
        }

        unsound++;
        process.stdout.write('\n');
        console.log(`[quiz ${row.id}] ${row.title}`);
        console.log(`  Q: ${String(q.question).slice(0, 100)}`);
        console.log(`  why: ${check.reason}`);
        report.push({ quizId: row.id, node: row.title, question: q.question, reason: check.reason });

        if (!REPAIR) { kept.push(q); continue; }

        let fixed = null;
        let fault = check.reason;
        for (let attempt = 0; attempt < REPAIR_ATTEMPTS && !fixed; attempt++) {
            const { system, user } = AI_PROMPTS.quiz_question_repair(row.title, q, fault, lang);
            let candidate;
            try {
                candidate = normalizeRepaired(parseObject(await generateResponse(user, system, [], { temperature: 0.4 })), q);
            } catch (e) {
                console.log(`  repair call failed: ${e.message}`);
                break;
            }
            if (!candidate) { fault = `${check.reason} (the previous rewrite was unusable or declared the question unfixable)`; continue; }
            // The rewrite has to clear the same bar the original failed.
            const recheck = await verifyQuestion(row.title, candidate, {});
            if (recheck.ok) { fixed = candidate; break; }
            fault = recheck.reason;
        }

        if (fixed) {
            repaired++;
            changed = true;
            kept.push(fixed);
            console.log(`  -> repaired: ${String(fixed.question).slice(0, 100)}`);
        } else {
            droppedCount++;
            changed = true;
            console.log('  -> dropped (no sound rewrite)');
        }
    }

    if (REPAIR && changed) {
        if (kept.filter(q => !q.isGhost).length === 0) {
            db.prepare('DELETE FROM quizzes WHERE id = ?').run(row.id);
            console.log(`  -> quiz ${row.id} removed (nothing gradeable left)`);
        } else {
            db.prepare('UPDATE quizzes SET questions = ? WHERE id = ?').run(JSON.stringify(kept), row.id);
        }
    }
    saveLedger();
}

console.log(`\n\n=== ${checked} questions checked ===`);
console.log(`unsound: ${unsound} (${checked ? (100 * unsound / checked).toFixed(1) : 0}%)`);
if (unavailable) {
    console.log(`NOT CHECKED: ${unavailable} — the verifier was unreachable for these. `
        + 'They are not "sound", they are unknown; re-run once the model answers.');
}
if (REPAIR) {
    console.log(`repaired: ${repaired}`);
    console.log(`dropped:  ${droppedCount}`);
} else if (unsound) {
    console.log('\nRe-run with --repair to rewrite these.');
}
