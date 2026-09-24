// server/placement.js — measure before you teach.
//
// Every topic starts at BKT 0.0, so a learner who already knows half a course is
// taught all of it. A placement probe is a short assessment taken BEFORE studying,
// spread across the curriculum; its answers seed the BKT prior on the topics it
// asked about and on the ones those answers vouch for.
//
// ## The boundary
//
// Same rules as server/masteryTransfer.js, deliberately shared:
//
//   • A seeded prior is capped below any sane `mastery_threshold` (`PLACEMENT_CEILING`).
//   • `checkMasteryEligibility` suspends the BKT clause on a seeded node until it has
//     `MIN_GATE_QUESTIONS` answers of its OWN.
//   • Seeds combine with MAX, never a sum (`applySeededPrior`).
//   • A node with real measurement is never re-seeded.
//
// A probe saves the *teaching*, never the proving: a perfect score leaves every gate shut.
//
// ## Propagation is by curriculum ORDER, within one top-level section
//
// A course is written easy-to-hard, so knowledge is modelled as a prefix of the leaf
// sequence (the learner knows positions 0..E):
//
//   • correct at position k  ⇒  E >= k  ⇒  everything at or before k is likely known
//   • wrong   at position k  ⇒  E <  k  ⇒  everything at or after  k is likely not
//
// An unprobed topic at j is seeded when the nearest probe at or after j was correct,
// and blocked when the nearest probe at or before j was wrong. Nearest-only keeps each
// claim local; a conflict blocks rather than averages, because over-seeding (a topic
// quietly skipped) costs more than under-seeding (a lesson already known).
//
// The prefix model holds only along a difficulty gradient, and a top-level section is
// the largest unit that can be assumed to have one: many projects are anthologies of
// unrelated subjects, where cross-section propagation was the common case (31–63% of
// propagated topics on four real anthology projects). So `next`/`prev` are searched in
// the topic's OWN section; a section with no probe is taught from zero. Model-free and
// deterministic, so `tools/placement-gates.mjs` asserts it.
//
// Not semantic similarity, inside or across sections: within a course it points at
// successors as readily as prerequisites, and between sections it measures topical
// overlap, which on real curricula runs opposite to a difficulty gradient (it linked
// parallel-skill projects most and an ordered maths course not at all). If revisited,
// measure whether mastery along the sequence behaves like a prefix, not meaning.
//
// ## Deliberately not here
//
// **In-flight adaptivity.** Each question costs a generation plus a cold-solve
// verification, so an adaptive probe would make the learner wait between questions; a
// stratified spread authored in one batch carries nearly the same information.
//
// **True/false.** A format at or above `MAX_GUESSABLE` seeds nothing, as an explicit
// rule: left to the discount arithmetic, a correct true/false lands at 0.275 against
// the 0.2 floor and buys a head start.
//
// With no AI there is no probe, and a project without one is unaffected.

import db from './database.js';
import { applySeededPrior, GUESS_BY_QUESTION_TYPE } from './mastery.js';
import { AI_PROMPTS, buildNodeContext, generateResponse, checkAnswerWithAI } from './ai.js';
import { parseJsonWithRepair, escapeLatexBackslashes, normalizeChoice, sanitizeExplanation } from './agentic.js';
import { questionDefects, verifyQuestion } from './feedQuality.js';
import { getProjectLanguage } from './language.js';

// Long enough to say something, short enough to still read as a warm-up. An
// unfinished probe seeds only what it measured.
export const MAX_PROBE_QUESTIONS = 12;
// Below this a project is faster to study than to probe.
export const MIN_PROBE_CANDIDATES = 6;

// A correct answer ON the topic, before the format discount. Below the ceiling, so
// even the strongest single answer (short answer, guess floor 0.05) cannot reach it.
export const DIRECT_PRIOR = 0.55;
// Multiplier for a topic an answer only vouches for: an inference is weaker than a
// direct answer.
export const PROPAGATION_DISCOUNT = 0.7;
// As TRANSFER_CEILING: strictly below the 0.85 default threshold and any plausible
// lowered one. A hard clamp.
export const PLACEMENT_CEILING = 0.6;
// Below this a head start ("you seem to know this already") is not supported.
export const PLACEMENT_MIN_PRIOR = 0.2;
// A format guessable at or above this rate is not evidence, however the discount
// lands. True/false (0.5) is the case; an unknown format counts as the most
// guessable known one, so it falls here too.
export const MAX_GUESSABLE = 0.35;


/**
 * The prior one probe answer is worth: `base × (1 − guess floor)`, as
 * `GUESS_BY_QUESTION_TYPE` discounts the BKT update. A format at or above
 * `MAX_GUESSABLE` is refused outright rather than discounted.
 */
export function priorFromAnswer(questionType, correct, { base = DIRECT_PRIOR } = {}) {
    if (!correct) return 0;
    const guess = GUESS_BY_QUESTION_TYPE[questionType];
    // Unknown format = the most guessable known one, so it never buys more.
    const floor = typeof guess === 'number' ? guess : Math.max(...Object.values(GUESS_BY_QUESTION_TYPE));
    if (floor >= MAX_GUESSABLE) return 0;
    return Math.min(PLACEMENT_CEILING, base * (1 - floor));
}

// ---- the curriculum as a sequence ------------------------------------------

/**
 * A project's leaves in curriculum order (depth-first by `position`), each with its
 * top-level phase.
 *
 * In JS rather than a recursive CTE so "leaf" matches `LEAF_NODE` (server/today.js)
 * exactly: a non-note node with no non-note children.
 */
export function leafSequence(projectId) {
    const rows = db.prepare(`
        SELECT id, parent_id, title, position, status, is_note
        FROM nodes
        WHERE project_id = ? AND is_note = 0
        ORDER BY position ASC, id ASC
    `).all(projectId);

    const byParent = new Map();
    for (const r of rows) {
        const key = r.parent_id ?? 0;
        if (!byParent.has(key)) byParent.set(key, []);
        byParent.get(key).push(r);
    }

    const out = [];
    const walk = (node, phase) => {
        const children = byParent.get(node.id) || [];
        if (children.length === 0) {
            out.push({
                node_id: node.id,
                title: node.title,
                status: node.status,
                seq: out.length,
                phase_id: phase ? phase.id : node.id,
                phase_title: phase ? phase.title : node.title,
            });
            return;
        }
        for (const c of children) walk(c, phase || node);
    };
    for (const root of byParent.get(0) || []) walk(root, null);
    return out;
}

/**
 * Leaves a probe may ask about: still open, with no mastery evidence of any kind
 * (inference must never overwrite measurement).
 */
export function probeCandidates(projectId) {
    const measured = new Set(db.prepare(`
        SELECT DISTINCT me.node_id
        FROM mastery_evidence me
        JOIN nodes n ON n.id = me.node_id
        WHERE n.project_id = ?
    `).all(projectId).map(r => r.node_id));

    return leafSequence(projectId).filter(l =>
        l.status !== 'completed' && l.status !== 'skipped' && !measured.has(l.node_id)
    );
}

/**
 * Apportion `limit` question slots across the phases, then pick evenly-spread
 * positions inside each, so every phase is sampled and each sample straddles the
 * easy-to-hard gradient propagation relies on.
 *
 * One slot per phase while the budget allows, then largest remainder by candidate
 * count; with more phases than slots, the phases are sampled evenly. Deterministic:
 * the same curriculum yields the same probe.
 */
export function selectProbeTargets(projectId, { limit = MAX_PROBE_QUESTIONS } = {}) {
    const candidates = probeCandidates(projectId);
    if (candidates.length === 0) return [];

    // Preserve first-appearance order of phases — that is curriculum order.
    const phases = [];
    const byPhase = new Map();
    for (const c of candidates) {
        if (!byPhase.has(c.phase_id)) { byPhase.set(c.phase_id, []); phases.push(c.phase_id); }
        byPhase.get(c.phase_id).push(c);
    }

    const budget = Math.max(1, Math.min(limit, candidates.length));
    const slots = new Map();

    if (phases.length >= budget) {
        // More phases than questions: one slot each for evenly-sampled phases.
        for (let i = 0; i < budget; i++) {
            slots.set(phases[Math.floor(((i + 0.5) * phases.length) / budget)], 1);
        }
    } else {
        for (const p of phases) slots.set(p, 1);
        let remaining = budget - phases.length;
        if (remaining > 0) {
            const total = candidates.length;
            const shares = phases.map(p => {
                const exact = (byPhase.get(p).length / total) * remaining;
                return { phase: p, whole: Math.floor(exact), frac: exact - Math.floor(exact) };
            });
            for (const s of shares) { slots.set(s.phase, slots.get(s.phase) + s.whole); remaining -= s.whole; }
            // Largest remainder; ties go by phase order (stable sort) so the
            // result is reproducible.
            shares.sort((a, b) => b.frac - a.frac);
            for (let i = 0; i < remaining; i++) {
                const s = shares[i % shares.length];
                slots.set(s.phase, slots.get(s.phase) + 1);
            }
        }
    }

    const picked = [];
    for (const [phase, k] of slots) {
        const pool = byPhase.get(phase);
        const take = Math.min(k, pool.length);
        for (let i = 0; i < take; i++) {
            picked.push(pool[Math.floor(((i + 0.5) * pool.length) / take)]);
        }
    }

    // Spreading can land twice on one leaf in a short pool; dedupe, curriculum order.
    const seen = new Set();
    return picked
        .filter(p => (seen.has(p.node_id) ? false : (seen.add(p.node_id), true)))
        .sort((a, b) => a.seq - b.seq);
}

// ---- propagation ------------------------------------------------------------

/**
 * Turn probe answers into seeded priors — the pure core, and the part
 * `tools/placement-gates.mjs` asserts.
 *
 * @param {Array}  sequence  every leaf, in curriculum order (from `leafSequence`)
 * @param {Array}  results   `[{ node_id, seq, correct, questionType }]` — one per answered probe question
 * @param {Set}    [measured] node ids that already have real evidence and must not be seeded
 * @returns {Map<number, {prior, kind, via, viaTitle}>}
 */
export function computeSeeds(sequence, results, measured = new Set()) {
    const seeds = new Map();
    if (!Array.isArray(results) || results.length === 0) return seeds;

    const probed = results
        .filter(r => r && Number.isFinite(r.seq))
        .map(r => ({
            ...r,
            prior: priorFromAnswer(r.questionType, !!r.correct),
        }))
        .sort((a, b) => a.seq - b.seq);
    if (probed.length === 0) return seeds;

    const probedSeqs = new Set(probed.map(p => p.seq));
    const byNode = new Map(sequence.map(l => [l.node_id, l]));

    // Topics asked directly. A wrong answer seeds nothing: no head start, not a penalty.
    for (const p of probed) {
        if (measured.has(p.node_id)) continue;
        if (p.prior >= PLACEMENT_MIN_PRIOR) {
            seeds.set(p.node_id, {
                prior: Math.min(PLACEMENT_CEILING, p.prior),
                kind: 'direct',
                via: p.node_id,
                viaTitle: byNode.get(p.node_id)?.title ?? null,
            });
        }
    }

    // Topics an answer vouches for: nearest probe on each side within the SAME
    // top-level section (see header). A probe whose leaf was deleted has no
    // section and vouches for nothing.
    for (const leaf of sequence) {
        if (probedSeqs.has(leaf.seq)) continue;          // asked directly, handled above
        if (measured.has(leaf.node_id)) continue;
        if (leaf.status === 'completed' || leaf.status === 'skipped') continue;

        const section = leaf.phase_id;
        const inSection = probed.filter(p => byNode.get(p.node_id)?.phase_id === section);
        if (inSection.length === 0) continue;            // no evidence about this subject

        let next = null;
        for (const p of inSection) { if (p.seq > leaf.seq) { next = p; break; } }
        if (!next || !next.correct) continue;

        let prev = null;
        for (const p of inSection) { if (p.seq < leaf.seq) prev = p; else break; }
        if (prev && !prev.correct) continue;             // conflict — stay conservative

        const prior = Math.min(PLACEMENT_CEILING, next.prior * PROPAGATION_DISCOUNT);
        if (prior < PLACEMENT_MIN_PRIOR) continue;
        seeds.set(leaf.node_id, {
            prior,
            kind: 'implied',
            via: next.node_id,
            viaTitle: byNode.get(next.node_id)?.title ?? null,
        });
    }

    return seeds;
}

// ---- persistence ------------------------------------------------------------

const probeRow = db.prepare('SELECT * FROM placement_probes WHERE id = ?');

function parseJson(text, fallback) {
    try {
        const v = JSON.parse(text || '');
        return v ?? fallback;
    } catch (_) { return fallback; }
}

export function hydrateProbe(row) {
    if (!row) return null;
    return {
        id: row.id,
        projectId: row.project_id,
        state: row.state,
        targets: parseJson(row.targets, []),
        questions: parseJson(row.questions, []),
        answers: parseJson(row.answers, []),
        error: row.error,
        createdAt: row.created_at,
        completedAt: row.completed_at,
    };
}

/** The project's current probe, whatever state it is in, or null. */
export function getProbe(projectId) {
    return hydrateProbe(db.prepare(
        'SELECT * FROM placement_probes WHERE project_id = ? ORDER BY id DESC LIMIT 1'
    ).get(projectId));
}

/**
 * Whether a probe is worth offering, and if not, why — an answer, not an error
 * (as the atlas does): "too small" and "already done" are healthy states.
 */
export function probeAvailability(projectId) {
    const existing = getProbe(projectId);
    if (existing && existing.state !== 'failed') {
        return { available: false, reason: existing.state === 'done' ? 'done' : 'in-progress', probe: existing };
    }
    const candidates = probeCandidates(projectId);
    if (candidates.length < MIN_PROBE_CANDIDATES) {
        return { available: false, reason: 'too-small', candidates: candidates.length };
    }
    return {
        available: true,
        candidates: candidates.length,
        questions: Math.min(MAX_PROBE_QUESTIONS, candidates.length),
    };
}

/**
 * Open the probe row before generation, so a reload mid-generation finds it rather
 * than starting a second one. Re-taking withdraws the previous probe's seeds first.
 */
export function createProbe(projectId, { limit = MAX_PROBE_QUESTIONS } = {}) {
    withdrawPlacement(projectId);
    db.prepare('DELETE FROM placement_probes WHERE project_id = ?').run(projectId);
    const targets = selectProbeTargets(projectId, { limit });
    if (targets.length === 0) throw new Error('This project has no unmeasured topics left to place.');
    db.prepare(
        "INSERT INTO placement_probes (project_id, state, targets) VALUES (?, 'generating', ?)"
    ).run(projectId, JSON.stringify(targets));
    return getProbe(projectId);
}

export function setProbeQuestions(probeId, questions) {
    db.prepare("UPDATE placement_probes SET questions = ?, state = 'ready' WHERE id = ?")
        .run(JSON.stringify(questions), probeId);
    return hydrateProbe(probeRow.get(probeId));
}

export function failProbe(probeId, message) {
    db.prepare("UPDATE placement_probes SET state = 'failed', error = ? WHERE id = ?")
        .run(String(message || 'unknown error').slice(0, 500), probeId);
}

/**
 * Record one answer and re-derive the whole seeding from every answer so far.
 *
 * Not incremental: a later wrong answer can withdraw what an earlier correct one
 * vouched for. Cheap — arithmetic over a few thousand leaves.
 */
export function recordProbeAnswer(probeId, { questionIndex, correct }) {
    const probe = hydrateProbe(probeRow.get(probeId));
    if (!probe) throw new Error('Probe not found');
    if (probe.state === 'done') throw new Error('This probe is already finished');

    const question = probe.questions[questionIndex];
    if (!question) throw new Error(`No probe question at index ${questionIndex}`);

    const answers = probe.answers.filter(a => a.questionIndex !== questionIndex);
    answers.push({ questionIndex, correct: !!correct, at: new Date().toISOString() });
    db.prepare('UPDATE placement_probes SET answers = ? WHERE id = ?')
        .run(JSON.stringify(answers), probeId);

    // Recorded as evidence, but outside the gate's raw-score clause (see
    // VALID_EVIDENCE_TYPES): one question per topic is not an assessment.
    try {
        recordPlacementEvidence(question.node_id, !!correct, question.type);
    } catch (err) {
        console.error('[Placement] failed to record evidence:', err.message);
    }

    return applyProbeSeeds(probe.projectId, { ...probe, answers });
}

/**
 * Evidence for a probe answer, written WITHOUT the BKT update: the seed already IS
 * this answer's contribution, and BKT on top would count it twice (a seeded 0.41
 * would land near 0.8 on one multiple-choice answer, past what the ceiling allows).
 */
function recordPlacementEvidence(nodeId, correct, questionType) {
    db.prepare(`
        INSERT INTO mastery_evidence (node_id, evidence_type, score, total, metadata)
        VALUES (?, 'placement', ?, 1, ?)
    `).run(nodeId, correct ? 1 : 0, JSON.stringify({ questionType, source: 'placement' }));
}

/**
 * Recompute every seed for this probe and write it. Idempotent.
 */
export function applyProbeSeeds(projectId, probe) {
    const sequence = leafSequence(projectId);
    const bySeq = new Map(sequence.map(l => [l.node_id, l.seq]));

    const results = probe.answers.map(a => {
        const q = probe.questions[a.questionIndex];
        if (!q) return null;
        return {
            node_id: q.node_id,
            seq: bySeq.get(q.node_id),
            correct: a.correct,
            questionType: q.type,
        };
    }).filter(r => r && Number.isFinite(r.seq));

    // Measured = evidence from anything but placement; the probe's own rows are
    // excluded or a topic would lose the seed its own answer just earned.
    const measured = new Set(db.prepare(`
        SELECT DISTINCT me.node_id
        FROM mastery_evidence me
        JOIN nodes n ON n.id = me.node_id
        WHERE n.project_id = ? AND me.evidence_type != 'placement'
    `).all(projectId).map(r => r.node_id));

    const seeds = computeSeeds(sequence, results, measured);

    // Withdraw first, or a seed a later wrong answer blocked would stay standing.
    withdrawPlacement(projectId, { except: seeds });

    let written = 0;
    for (const [nodeId, seed] of seeds) {
        const res = applySeededPrior(nodeId, 'placement', seed.prior, [{
            kind: seed.kind,
            via_node_id: seed.via,
            via_title: seed.viaTitle,
        }]);
        if (res.written) written++;
    }
    return { seeded: written, considered: seeds.size, answers: results.length };
}

/**
 * Clear placement seeds across a project. `applySeededPrior` refuses a node with
 * real attempts, and a transfer seed on the same node stands (the score is
 * recomputed from both columns).
 */
export function withdrawPlacement(projectId, { except = null } = {}) {
    const rows = db.prepare(`
        SELECT nm.node_id FROM node_mastery nm
        JOIN nodes n ON n.id = nm.node_id
        WHERE n.project_id = ? AND nm.placement_prior IS NOT NULL
    `).all(projectId);
    let cleared = 0;
    for (const r of rows) {
        if (except && except.has(r.node_id)) continue;
        const res = applySeededPrior(r.node_id, 'placement', 0);
        if (res.written) cleared++;
    }
    return cleared;
}

/** Close the probe. A probe can be finished early — it seeds what it measured. */
export function finishProbe(probeId) {
    db.prepare("UPDATE placement_probes SET state = 'done', completed_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(probeId);
    const probe = hydrateProbe(probeRow.get(probeId));
    return { probe, summary: summariseProbe(probe) };
}

/**
 * Discard a probe and everything it seeded. Fully reversible, so taking a probe
 * carries no risk that skipping it does not.
 */
export function discardProbe(projectId) {
    const cleared = withdrawPlacement(projectId);
    db.prepare(`
        DELETE FROM mastery_evidence
        WHERE evidence_type = 'placement'
          AND node_id IN (SELECT id FROM nodes WHERE project_id = ?)
    `).run(projectId);
    db.prepare('DELETE FROM placement_probes WHERE project_id = ?').run(projectId);
    return { cleared };
}

export function summariseProbe(probe) {
    if (!probe) return null;
    const answered = probe.answers.length;
    const correct = probe.answers.filter(a => a.correct).length;
    const seeded = db.prepare(`
        SELECT COUNT(*) AS n FROM node_mastery nm
        JOIN nodes n ON n.id = nm.node_id
        WHERE n.project_id = ? AND nm.placement_prior IS NOT NULL
    `).get(probe.projectId).n;
    return {
        answered,
        correct,
        total: probe.questions.length,
        topicsSeeded: seeded,
        // A seed is a starting point, not "you already know this": the gate still wants proof.
        headline: seeded > 0
            ? `${seeded} topic${seeded === 1 ? ' starts' : 's start'} with a head start — you still prove them as you go.`
            : 'No head start this time — the feed will teach these from the beginning.',
    };
}

export function getProbeById(probeId) {
    return hydrateProbe(db.prepare('SELECT * FROM placement_probes WHERE id = ?').get(probeId));
}

// ---- authoring --------------------------------------------------------------
//
// One question per target, through the same gates as a feed question
// (`questionDefects`, then the cold-solve verifier). The stakes are higher here: a
// broken key silently decides, through propagation, how much of the course is taught.
// A target that cannot be authored soundly is DROPPED, shortening the probe rather
// than mismeasuring the course.

const AUTHOR_ATTEMPTS = 2;
const MAX_CONSECUTIVE_TRANSPORT_FAILURES = 2;

// Every third question is open: stronger evidence than multiple choice (guess floor
// 0.05 vs 0.25) but an AI grading call each, so the probe mixes the two.
function questionTypeFor(index) {
    return index % 3 === 2 ? 'short_answer' : 'multiple_choice';
}

function normalizeProbeQuestion(raw, type, nodeId = null) {
    if (!raw || typeof raw !== 'object') return null;
    const q = { ...raw, type };
    if (typeof q.question !== 'string' || !q.question.trim()) return null;

    if (type === 'multiple_choice') {
        const opts = Array.isArray(q.options)
            ? q.options.filter(o => typeof o === 'string' && o.trim())
            : [];
        if (opts.length < 2) return null;
        q.options = opts;
        if (!opts.includes(q.correct_answer)) {
            const target = normalizeChoice(q.correct_answer);
            const match = opts.find(o => normalizeChoice(o) === target);
            if (!match) return null;              // cannot identify the key — drop, never guess
            q.correct_answer = match;
        }
        // Before the shuffle, while the model's own ordering still holds.
        q.explanation = sanitizeExplanation(q.explanation, q.options);
        for (let i = q.options.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [q.options[i], q.options[j]] = [q.options[j], q.options[i]];
        }
    } else {
        if (typeof q.correct_answer !== 'string' || !q.correct_answer.trim()) return null;
        q.explanation = sanitizeExplanation(q.explanation);
    }

    // A true/false would seed nothing yet spend a slot and mark its topic measured.
    if (q.type === 'true_false') return null;

    const defects = questionDefects(q, nodeId);
    if (defects.length) return { rejected: defects.join('; ') };
    return q;
}

/**
 * Author one probe question for one target.
 *
 * Returns the question, `null` when it could not be written soundly, or
 * `{transportError}` when the model was unreachable — the caller treats those two
 * differently. Only an abort throws.
 */
export async function authorProbeQuestion(target, { signal, lang = null, index = 0 } = {}) {
    const type = questionTypeFor(index);
    const context = buildNodeContext(target.node_id);
    let priorFault = null;

    for (let attempt = 0; attempt < AUTHOR_ATTEMPTS; attempt++) {
        const { system, user } = AI_PROMPTS.placement_question(target.title, type, {
            context, phaseTitle: target.phase_title, lang, priorFault,
        });
        let parsed;
        try {
            // `operation: 'authoring'` buys the 300s budget; a thinking local model
            // blows the 120s default on most targets.
            const resp = await generateResponse(user, system, [], {
                temperature: 0.4, signal, operation: 'authoring',
            });
            const match = resp.match(/\{[\s\S]*\}/);
            if (!match) { priorFault = 'the reply contained no JSON object'; continue; }
            parsed = parseJsonWithRepair(escapeLatexBackslashes(match[0]));
        } catch (err) {
            if (err?.name === 'AbortError') throw err;
            // Not retried like a content failure: the same prompt carries no new
            // `priorFault` and would just pay the timeout twice.
            return { transportError: err.message };
        }

        const q = normalizeProbeQuestion(parsed, type, target.node_id);
        if (!q) { priorFault = 'the question had no identifiable answer key'; continue; }
        if (q.rejected) { priorFault = q.rejected; continue; }

        const verdict = await verifyQuestion(target.title, q, { signal });
        if (verdict.ok === false) { priorFault = verdict.reason; continue; }

        return {
            ...q,
            node_id: target.node_id,
            seq: target.seq,
            node_title: target.title,
            phase_title: target.phase_title,
            // An unreachable verifier (`available: false`) degrades to serving, but
            // is recorded so a probe authored during an outage reads as unverified.
            verified: verdict.available === true,
        };
    }
    console.warn(`[Placement] dropped target "${target.title}": ${priorFault}`);
    return null;
}

/**
 * Author every question for a probe, in curriculum order, reporting progress.
 *
 * Serial: a local model is usually single-slot, so parallelism buys contention
 * (as in `embeddings.js` and `feedGen.js`).
 */
export async function generateProbeQuestions(probe, { emit, signal } = {}) {
    const lang = getProjectLanguage(probe.projectId);
    const questions = [];
    // As tools/quiz-audit.mjs: stop once the model stops answering. Two consecutive
    // transport failures at 300s each is already ten minutes.
    let consecutiveTransportFailures = 0;
    for (let i = 0; i < probe.targets.length; i++) {
        if (signal?.aborted) break;
        emit?.({ phase: 'authoring', written: questions.length, total: probe.targets.length });
        const q = await authorProbeQuestion(probe.targets[i], { signal, lang, index: i });
        if (q?.transportError) {
            if (++consecutiveTransportFailures >= MAX_CONSECUTIVE_TRANSPORT_FAILURES) {
                console.warn('[Placement] stopping early — the model stopped responding');
                break;
            }
            continue;
        }
        consecutiveTransportFailures = 0;
        if (q) questions.push(q);
    }
    if (questions.length === 0) {
        failProbe(probe.id, 'no question could be written soundly');
        throw new Error('No probe question could be written soundly — the model may be unreachable. You can start studying without a placement; the feed works the same way.');
    }
    setProbeQuestions(probe.id, questions);
    emit?.({ phase: 'ready', written: questions.length, total: probe.targets.length });
    return getProbe(probe.projectId);
}

/**
 * Grade one probe answer and fold it into the seeding.
 *
 * Graded on the server from the stored row: the verdict decides how much of the
 * course is taught, so the browser may not assert it.
 */
export async function answerProbeQuestion(probeId, questionIndex, userAnswer) {
    const probe = getProbeById(probeId);
    if (!probe) throw new Error('Probe not found');
    const q = probe.questions[questionIndex];
    if (!q) throw new Error(`No probe question at index ${questionIndex}`);

    let correct = false;
    let explanation = q.explanation || '';
    if (q.type === 'multiple_choice') {
        correct = normalizeChoice(userAnswer) === normalizeChoice(q.correct_answer);
    } else {
        const graded = await checkAnswerWithAI(q.question, q.correct_answer, String(userAnswer ?? ''));
        correct = !!graded.correct;
        if (graded.explanation) explanation = graded.explanation;
    }

    const seeding = recordProbeAnswer(probeId, { questionIndex, correct });
    return { correct, explanation, correctAnswer: q.correct_answer, seeding };
}
