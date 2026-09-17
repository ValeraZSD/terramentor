/**
 * Bulk study-material generation: boss fights and flashcards, many topics at once.
 *
 * "Generate for this whole phase" is the difference between preparing for an
 * exam on Sunday evening and clicking Generate forty times. But it is also the
 * most expensive thing a learner can ask this app to do — one model call per
 * topic per kind — so the design is built around three rules:
 *
 *  1. IT YIELDS. Like feedGen and embeddings, this runs on its OWN serial
 *     promise chain, not the tasks.js FIFO, and it checks before every model
 *     call whether a person is waiting (tasks.interactiveActive). A tutor reply
 *     must never queue behind a forty-topic batch. The batch simply pauses and
 *     resumes when the model is free again.
 *  2. IT COMMITS AS IT GOES. Every topic's material is written the moment it is
 *     generated. Cancelling, closing the laptop or a model dying at topic 30
 *     leaves 29 topics' worth of real material — never an all-or-nothing job
 *     that throws away twenty minutes of GPU time.
 *  3. ONE FAILURE IS NOT THE END. A topic that fails is recorded with its
 *     reason and the run moves on. The result is a report, not an exception.
 *
 * Only one job runs at a time (a second request replaces nothing and is
 * refused) — the model can only do one thing anyway, and two competing bulk
 * jobs would just interleave into a slower one.
 */
import db from './database.js';
import { generateResponse, getAISettings } from './ai.js';
import {
    buildQuizPrompt, buildFlashcardPrompt, finalizeQuiz, finalizeFlashcards, vetQuiz,
} from './studyMaterial.js';
import { WORK_LEAF } from './today.js';
import { MIN_GATE_QUESTIONS } from './mastery.js';
import * as tasks from './tasks.js';

/** Model calls this many topics past the reader before checking for interactive work. */
const YIELD_POLL_MS = 5000;
/** A cap so a mis-click can't queue a thousand model calls. */
export const MAX_BULK_NODES = 60;

/**
 * The two kinds of material worth making ahead of time.
 *
 * `boss_fight` used to be called `quiz`, and the rename is the honest name for
 * what was always happening: a node's saved questions ARE its Boss Fight bank
 * (`MasteryGateModal` reads every non-ghost question the node has and only
 * generates when it finds none). So "bulk quiz" was never making practice
 * quizzes — it was pre-loading the gate, at 5 questions, while the gate itself
 * asks for 10 and needs `MIN_GATE_QUESTIONS` to count as an assessment at all.
 * Calling it a quiz made the expensive path look optional and made the useful
 * one invisible. `quiz` is still accepted from older clients.
 */
export const BULK_KINDS = ['boss_fight', 'flashcards'];

/** Older clients (and the previous dialog) say `quiz`; it means the same rows. */
export function normalizeKind(kind) {
    return kind === 'quiz' ? 'boss_fight' : kind;
}

/** How long a call of each kind took last time, so the dialog can say "~6 min". */
const AVG_SETTING = { boss_fight: 'bulk_avg_ms_boss_fight', flashcards: 'bulk_avg_ms_flashcards' };
/** Used until a run of that kind has actually been measured on this machine. */
const AVG_FALLBACK_MS = { boss_fight: 75000, flashcards: 35000 };

function getSetting(key) {
    try {
        return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
    } catch { return null; }
}
function setSetting(key, value) {
    try {
        db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
    } catch { /* a timing hint is never worth failing a run over */ }
}

/**
 * Measured milliseconds per call, per kind. An estimate is only worth showing
 * when it came from this machine's own model, so a never-measured kind reports
 * `measured: false` and the UI can hedge accordingly.
 */
export function bulkEstimates() {
    const out = {};
    for (const kind of BULK_KINDS) {
        const raw = Number(getSetting(AVG_SETTING[kind]));
        out[kind] = raw > 0
            ? { ms: Math.round(raw), measured: true }
            : { ms: AVG_FALLBACK_MS[kind], measured: false };
    }
    return out;
}

/** Rolling average, weighted toward recent runs — the model or the box may change. */
function recordDuration(kind, ms) {
    if (!(ms > 0) || ms > 30 * 60 * 1000) return;
    const prev = Number(getSetting(AVG_SETTING[kind]));
    const next = prev > 0 ? prev * 0.7 + ms * 0.3 : ms;
    setSetting(AVG_SETTING[kind], Math.round(next));
}

/**
 * Does this topic still need work of this kind?
 *
 * The old rule was "does a quiz row exist", which is not the question anyone is
 * asking: a node holding one 2-question quiz was reported as covered and
 * skipped forever, while its Boss Fight could never reach `MIN_GATE_QUESTIONS`
 * and so could never count as an assessment. Coverage is counted in QUESTIONS,
 * against the bar the gate actually uses.
 */
export function needsKind(candidate, kind) {
    return kind === 'boss_fight'
        ? candidate.questions < MIN_GATE_QUESTIONS
        : candidate.flashcards === 0;
}

let job = null;          // the one live job, or null
let chain = Promise.resolve();

/**
 * Leaves of a project that bulk generation may target, with what they already
 * have. Notes are excluded (they are material, not topics to be tested) and so
 * are closed topics only if the caller asks — a completed topic is a perfectly
 * good thing to build revision cards for, which is exactly what exam prep is.
 */
export function bulkCandidates(projectId) {
    const rows = db.prepare(`
        SELECT n.id, n.title, n.status, n.parent_id, n.position, n.scheduled_end
        FROM nodes n
        WHERE n.project_id = ? AND ${WORK_LEAF}
        ORDER BY n.position ASC, n.id ASC
    `).all(projectId);

    const quizCounts = new Map(db.prepare(`
        SELECT q.node_id AS id, COUNT(*) AS c FROM quizzes q
        JOIN nodes n ON n.id = q.node_id WHERE n.project_id = ? GROUP BY q.node_id
    `).all(projectId).map(r => [r.id, r.c]));

    // What the Boss Fight will actually find: every non-ghost question the node
    // owns, across all its saved quizzes. Ghosts belong to other topics and the
    // gate filters them out, so counting them would overstate coverage.
    const questionCounts = new Map(db.prepare(`
        SELECT q.node_id AS id, COUNT(*) AS c
        FROM quizzes q
        JOIN nodes n ON n.id = q.node_id
        JOIN json_each(q.questions) je
        WHERE n.project_id = ?
          AND COALESCE(json_extract(je.value, '$.isGhost'), 0) = 0
        GROUP BY q.node_id
    `).all(projectId).map(r => [r.id, r.c]));
    const cardCounts = new Map(db.prepare(`
        SELECT f.node_id AS id, COUNT(*) AS c FROM flashcards f
        JOIN nodes n ON n.id = f.node_id WHERE n.project_id = ? GROUP BY f.node_id
    `).all(projectId).map(r => [r.id, r.c]));

    // The path a learner recognises ("Phase 2 › Recursion"), built from the
    // ancestors rather than shown as a flat list of leaf titles — in a real
    // curriculum half the leaves are called "Introduction".
    const titleById = new Map(db.prepare('SELECT id, title, parent_id FROM nodes WHERE project_id = ?')
        .all(projectId).map(r => [r.id, r]));
    const pathOf = (node) => {
        const parts = [];
        let cur = titleById.get(node.parent_id);
        let guard = 0;
        while (cur && guard++ < 12) {
            parts.unshift(cur.title);
            cur = titleById.get(cur.parent_id);
        }
        return parts.join(' › ');
    };

    return rows.map(n => {
        const questions = questionCounts.get(n.id) || 0;
        return {
            nodeId: n.id,
            title: n.title,
            path: pathOf(n),
            /** Top-level section, so the picker can group by something a learner recognises. */
            section: pathOf(n).split(' › ')[0] || '',
            status: n.status,
            scheduledEnd: n.scheduled_end,
            quizzes: quizCounts.get(n.id) || 0,
            questions,
            /** Enough of its own questions to be a real assessment, not a taster. */
            gateReady: questions >= MIN_GATE_QUESTIONS,
            flashcards: cardCounts.get(n.id) || 0,
        };
    });
}

/** Public view of the running job — what the dialog and the dock render. */
export function bulkStatus() {
    if (!job) return null;
    return {
        id: job.id,
        projectId: job.projectId,
        kinds: job.kinds,
        total: job.total,
        done: job.done,
        failed: job.failures.length,
        skipped: job.skipped,
        current: job.current,
        waiting: job.waiting,
        etaMs: job.eta(),
        status: job.status,
        failures: job.failures.slice(0, 20),
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
    };
}

export function cancelBulk() {
    if (!job || job.status !== 'running') return false;
    job.cancelled = true;
    job.controller.abort();
    return true;
}

/** Pause while a person is waiting on the model. Resolves when it's our turn. */
async function waitForModel(j) {
    if (!tasks.interactiveActive(['bulk'])) return;
    j.waiting = true;
    j.handle?.update({ message: 'Paused — the model is answering you', percent: j.percent() });
    while (tasks.interactiveActive(['bulk']) && !j.cancelled) {
        await new Promise(r => setTimeout(r, YIELD_POLL_MS));
    }
    j.waiting = false;
}

/**
 * Start a bulk run. Returns the job status immediately — the work happens on
 * the chain. Throws only for a request that cannot be started at all (AI off,
 * a job already running, nothing to do).
 */
export function startBulk({ projectId, nodeIds, kinds, questionCount = 5, cardCount = 8, skipExisting = true }) {
    if (job && job.status === 'running') {
        const err = new Error('A bulk generation is already running. Wait for it or cancel it first.');
        err.status = 409;
        throw err;
    }
    const settings = getAISettings();
    if (!settings.enabled || !settings.model) {
        const err = new Error('AI is off or no model is selected.');
        err.status = 400;
        throw err;
    }
    const asked = (Array.isArray(kinds) ? kinds : []).map(normalizeKind);
    const wanted = BULK_KINDS.filter(k => asked.includes(k));
    if (!wanted.length) {
        const err = new Error('Pick at least one of: boss fight, flashcards.');
        err.status = 400;
        throw err;
    }

    // Resolve the ids against the project's real leaves, so a stale client list
    // (a topic deleted since the dialog opened, or an id from another project)
    // can never queue work for something that isn't there.
    const candidates = new Map(bulkCandidates(projectId).map(c => [c.nodeId, c]));
    const targets = [];
    let skipped = 0;
    for (const id of nodeIds.slice(0, MAX_BULK_NODES)) {
        const c = candidates.get(Number(id));
        if (!c) continue;
        const todo = wanted.filter(k => !skipExisting || needsKind(c, k));
        if (!todo.length) { skipped++; continue; }
        targets.push({ ...c, todo });
    }
    if (!targets.length) {
        const err = new Error(skipped
            ? 'Every topic you picked already has this material. Untick "Only what is missing" to add more.'
            : 'None of those topics could be found in this project.');
        err.status = 400;
        throw err;
    }

    const project = db.prepare('SELECT name, color FROM projects WHERE id = ?').get(projectId);
    const controller = new AbortController();
    job = {
        id: `bulk-${Date.now()}`,
        projectId,
        kinds: wanted,
        targets,
        // Floor is MIN_GATE_QUESTIONS, not 3: a bank too small to be an
        // assessment is a bank that cost a model call and proves nothing.
        questionCount: Math.min(15, Math.max(MIN_GATE_QUESTIONS, Number(questionCount) || 10)),
        cardCount: Math.min(20, Math.max(3, Number(cardCount) || 8)),
        total: targets.reduce((n, t) => n + t.todo.length, 0),
        done: 0,
        skipped,
        failures: [],
        current: null,
        waiting: false,
        cancelled: false,
        status: 'running',
        controller,
        handle: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        durations: [],   // measured ms per finished call, this run
        percent() { return this.total ? Math.min(99, Math.round((this.done / this.total) * 100)) : 0; },
        /**
         * Milliseconds left, from this run's OWN measurements once it has any —
         * an estimate carried over from a different model would be worse than
         * none. Null while nothing has been measured and nothing is stored.
         */
        eta() {
            if (this.status !== 'running') return null;
            const remaining = this.targets
                .flatMap(t => t.todo)
                .slice(this.done)
                .reduce((sum, kind) => sum + (this.avgFor(kind) ?? 0), 0);
            return remaining > 0 ? Math.round(remaining) : null;
        },
        avgFor(kind) {
            const mine = this.durations.filter(d => d.kind === kind);
            if (mine.length) return mine.reduce((a, d) => a + d.ms, 0) / mine.length;
            const est = bulkEstimates()[kind];
            return est ? est.ms : null;
        },
    };
    job.handle = tasks.registerExternal({
        kind: 'bulk',
        label: `Study material · ${project?.name || 'project'}`,
        projectId,
        projectName: project?.name || null,
        projectColor: project?.color || null,
        cancel: () => cancelBulk(),
    });

    chain = chain.then(() => runJob(job)).catch(err => {
        console.error('[Bulk] Unexpected chain error:', err?.message);
    });
    return bulkStatus();
}

async function runJob(j) {
    const decayDays = 14; // ghosts are never injected here — see below
    try {
        for (const target of j.targets) {
            for (const kind of target.todo) {
                if (j.cancelled) throw new Error('cancelled');
                await waitForModel(j);
                if (j.cancelled) throw new Error('cancelled');

                j.current = { nodeId: target.nodeId, title: target.title, kind };
                j.handle?.update({
                    percent: j.percent(),
                    message: `${j.done + 1}/${j.total} · ${target.title} — ${kind === 'boss_fight' ? 'boss fight' : 'flashcards'}`,
                });

                const startedAt = Date.now();
                try {
                    if (kind === 'boss_fight') {
                        const { system, user } = buildQuizPrompt(target.nodeId, j.questionCount, 'both');
                        const raw = await generateResponse(user, system, [], {
                            signal: j.controller.signal, operation: 'authoring',
                        });
                        // includeGhosts is FALSE on purpose: these quizzes are
                        // built ahead of time, and a ghost question chosen weeks
                        // before it is answered is not the "what is decaying
                        // right now" signal the Remember loop depends on.
                        // Vetted exactly like a Boss Fight quiz — a quiz made
                        // for twenty topics at once must be indistinguishable
                        // from one made for a single topic, or "generate for the
                        // whole phase" quietly becomes the unchecked path.
                        await vetQuiz(target.nodeId, finalizeQuiz(target.nodeId, raw, false, { decayDays }), {
                            signal: j.controller.signal,
                        });
                    } else {
                        const { system, user } = buildFlashcardPrompt(target.nodeId, j.cardCount);
                        const raw = await generateResponse(user, system, [], {
                            signal: j.controller.signal, operation: 'authoring',
                        });
                        finalizeFlashcards(target.nodeId, raw);
                    }
                    j.durations.push({ kind, ms: Date.now() - startedAt });
                    recordDuration(kind, Date.now() - startedAt);
                    j.done++;
                } catch (err) {
                    if (j.cancelled) throw new Error('cancelled');
                    // One topic's failure is a line in the report, not the end
                    // of the run — the next topic is a completely independent
                    // request and may well succeed.
                    j.failures.push({ nodeId: target.nodeId, title: target.title, kind, error: err.message });
                    j.done++;
                    console.warn(`[Bulk] ${target.title} (${kind}) failed: ${err.message}`);
                }
            }
        }
        j.status = 'done';
        j.handle?.finish();
    } catch (err) {
        if (j.cancelled) {
            j.status = 'cancelled';
            j.handle?.cancelled();
        } else {
            j.status = 'failed';
            j.handle?.fail(err.message);
        }
    } finally {
        j.current = null;
        j.finishedAt = new Date().toISOString();
    }
}
