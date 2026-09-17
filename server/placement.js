// server/placement.js — measure before you teach.
//
// Every topic in this engine starts at zero. `getNodeMastery` inserts a row at
// 0.0 and BKT climbs from there, so a learner who already knows half a course
// is taught all of it and has to answer their way out of each topic one at a
// time. That is the opposite of what `CoreIdea.md` promises — a path that
// "minimises teaching what the learner already holds" cannot be built by a
// system that has never asked.
//
// A placement probe asks. It is a short assessment taken BEFORE studying,
// spread across the curriculum, whose answers seed the BKT prior on the topics
// it asked about and on the ones those answers vouch for.
//
// ## The boundary, which is the whole design
//
// This is the second feature that hands the learner an estimate they did not
// earn here, and it inherits the first one's rules wholesale
// (server/masteryTransfer.js) because they were right and because two features
// with two boundaries is how a boundary stops existing:
//
//   • A seeded prior is capped strictly below any sane `mastery_threshold`
//     (`PLACEMENT_CEILING`), so no probe result can reach the bar.
//   • `checkMasteryEligibility` suspends the BKT clause entirely on a seeded
//     node until it has `MIN_GATE_QUESTIONS` answers of its OWN.
//   • Seeds combine with MAX, never a sum (`applySeededPrior`).
//   • A node with real measurement is never re-seeded.
//
// So a probe saves the learner the *teaching*, never the proving — the same
// contract as transfer. A perfect probe score still leaves every topic
// unproven and every gate shut.
//
// ## How answers propagate, and why it is ordering rather than similarity
//
// A 12-question probe over a 200-topic course would be nearly worthless if it
// only seeded the 12 topics it asked about, so answers have to carry. Mastery
// transfer carries them by *semantic similarity*, and that is deliberately not
// reused here. Transfer is cross-project only precisely because two similar
// topics inside ONE course are the author's structure — a prerequisite and the
// thing it leads to — and 1.1 resembling 1.3 is not evidence that knowing 1.1
// means knowing 1.3. Inside a project, similarity points at the successor as
// readily as the prerequisite, which is the wrong direction.
//
// Curriculum ORDER points one way. A course is written easy-to-hard, so
// knowledge behaves approximately like a prefix of the leaf sequence: the
// learner knows positions 0..E and not beyond. Under that model an answer is
// informative in exactly one direction each:
//
//   • correct at position k  ⇒  E >= k  ⇒  everything at or before k is likely known
//   • wrong   at position k  ⇒  E <  k  ⇒  everything at or after  k is likely not
//
// which is the information structure a binary search over an ordered
// curriculum actually exploits. So an unprobed topic at position j is seeded
// when the **nearest probe at or after j** was answered correctly, and blocked
// when the **nearest probe at or before j** was answered wrongly. Taking the
// nearest on each side keeps every claim local — one lucky answer on the last
// question cannot vouch for the whole course — and letting a conflict block
// rather than average keeps it conservative, because the prefix model is an
// approximation and the cost of over-seeding (a topic quietly skipped) is
// worse than the cost of under-seeding (a lesson the learner already knew).
//
// ## Propagation stops at the section boundary, and that is the whole of it
//
// The prefix model above holds only where the ordering is a DIFFICULTY
// gradient. A top-level section is the largest unit this engine can assume
// that of: inside one, the author wrote easy-to-hard and the prefix claim is
// the author's own structure. ACROSS sections it is not a claim about the
// learner at all — plenty of real projects are anthologies whose sections are
// unrelated subjects sharing one container (a roadmap spanning maths, control
// and hardware), and there a correct kana answer would vouch for the tail of a
// systems section purely because it was asked later. Measured on a real library
// before this rule, the share of propagated topics whose vouching answer came
// from a DIFFERENT section was 31%, 42%, 57% and 63% across its four
// anthology-shaped projects — i.e. the failure was the common case, not an
// edge.
//
// So `next` and `prev` are searched among the probes in the topic's OWN
// section only. A section holding no probe of its own propagates nothing and
// is taught from zero, which is the honest reading: 12 questions cannot place
// a learner across 17 independent subjects, and having no evidence about a
// subject is not the same as having evidence against it. The cost is paid in
// the cheap direction — a lesson the learner already knew — which is the same
// trade every other rule in this file makes.
//
// It is model-free and deterministic, which means the propagation can be
// asserted in `tools/placement-gates.mjs` rather than trusted.
//
// ## Linking sections back together was BUILT, MEASURED and REMOVED
//
// The section rule is blunt: a genuinely ordered course cut into ten sections
// loses the inference across every cut, and across those cuts the prefix model
// was sound. The obvious rescue is to link two sections back together when the
// topic vectors say they are one continuous subject, so it was built — mean
// pairwise cosine within each section against the mean between them (both
// exact O(n) reads from the set means, for unit vectors), compared as a RATIO
// so no absolute threshold is tuned to one embedding model.
//
// It does not work, and the measurement is worth keeping because the reason
// generalises. Raw ratios link nearly everything: text embeddings here are
// anisotropic (on the real library every pair sits near 0.55 — whole-project
// mean 0.549, within-section 0.612, cross-section 0.544), so 0.9 × within is
// below the floor the model puts under every pair. Centring on the project's
// own baseline fixes that and reveals the real problem — the signal sorts the
// projects the WRONG WAY ROUND. Best cross-section excess ratio, measured:
//
//   ordered graded maths (ordered, graded, the intended beneficiary)  0.415  — links nothing
//   ordered graded physics                                            0.649
//   an anthology (the failure case)                                   0.586
//   parallel practical skills                                         1.202  — links the most
//
// Because similarity between sections measures TOPICAL OVERLAP, and the prefix
// model needs a DIFFICULTY GRADIENT. On real curricula those are close to
// anti-correlated: a well-ordered course covers different material in each
// section — that is what the ordering is FOR — while a topically uniform
// project is a set of parallel skills with no gradient at all. So the test
// would have withheld the enhancement from exactly the courses it was written
// for and handed it to the ones the section rule exists to protect.
//
// Removed rather than retuned. No constant fixes a measure pointing the wrong
// way, and it would also have made the one model-free, assertable part of
// placement depend on whether an embedding model answered. If this is
// revisited, the thing to measure is ordering (does mastery along the sequence
// actually behave like a prefix?), not meaning.
//
// ## What is deliberately NOT here
//
// **In-flight adaptivity.** A true binary search picks question k+1 from the
// answer to question k. Each question here costs a generation plus a cold-solve
// verification, so an adaptive probe generates serially with the learner
// waiting between every question — and on a tree with no measured difficulty
// ordering, a stratified spread generated in one batch carries nearly the same
// information for a fraction of the wait. The adaptivity that pays is in the
// propagation, and that is above.
//
// **True/false questions.** A correct coin flip is not evidence, and the engine
// already says so (`GUESS_BY_QUESTION_TYPE`). Priors are discounted by the
// format's guess floor, and a format at or above `MAX_GUESSABLE` seeds nothing
// at all — stated as its own rule rather than left to fall out of the
// arithmetic, because it very nearly did not: at the tuned constants a correct
// true/false discounted to 0.275 against a 0.2 floor, i.e. half a coin flip
// bought a head start, and only `tools/placement-gates.mjs` said so. A property
// that holds because two unrelated numbers happen to multiply out is one tuning
// pass away from not holding.
//
// Everything degrades: no AI, no probe — and a project without one behaves
// exactly as it did before this file existed.

import db from './database.js';
import { applySeededPrior, GUESS_BY_QUESTION_TYPE } from './mastery.js';
import { AI_PROMPTS, buildNodeContext, generateResponse, checkAnswerWithAI } from './ai.js';
import { parseJsonWithRepair, escapeLatexBackslashes, normalizeChoice, sanitizeExplanation } from './agentic.js';
import { questionDefects, verifyQuestion } from './feedQuality.js';
import { getProjectLanguage } from './language.js';

// A probe long enough to say something and short enough to finish. An
// unfinished probe seeds only what it measured, so the cost of overshooting is
// not a wasted probe but a smaller one — still, 12 questions is roughly the
// point where a "before we start" task stops reading as a warm-up.
export const MAX_PROBE_QUESTIONS = 12;
// Below this there is nothing to place. A four-topic project is faster to study
// than to probe, and a probe that asks about most of the course is just a quiz.
export const MIN_PROBE_CANDIDATES = 6;

// The prior a correct answer ON the topic itself is worth, before the format
// discount. Sits below the ceiling so even the strongest single answer
// (short answer, guess floor 0.05) cannot reach it.
export const DIRECT_PRIOR = 0.55;
// What an answer is worth for a topic it only vouches for. An inference from a
// neighbouring position is real information and weaker than a direct answer;
// this is the gap.
export const PROPAGATION_DISCOUNT = 0.7;
// Same value and the same reason as TRANSFER_CEILING: strictly below the 0.85
// default threshold, and below any threshold a user would plausibly configure
// downward. A hard clamp, not an expectation.
export const PLACEMENT_CEILING = 0.6;
// Below this a head start is not worth claiming — it would put a sentence on a
// card ("you seem to know this already") that the estimate does not support.
export const PLACEMENT_MIN_PRIOR = 0.2;
// A format guessable at or above this rate is not evidence of anything, however
// the discount arithmetic lands. True/false (0.5) is the case this exists for;
// an unrecognised format is treated as the most guessable known one and so
// falls here too, which is the safe direction for a value that decides mastery.
export const MAX_GUESSABLE = 0.35;


/**
 * The prior one probe answer is worth, discounted by how cheaply the format
 * can be guessed. This is the same argument `GUESS_BY_QUESTION_TYPE` makes for
 * the BKT update, applied at the one other place an answer becomes a number: a
 * correct four-option answer is 0.75 of a signal and a correct open answer
 * nearly all of one, while a format at or above `MAX_GUESSABLE` is refused
 * outright rather than discounted to something small.
 */
export function priorFromAnswer(questionType, correct, { base = DIRECT_PRIOR } = {}) {
    if (!correct) return 0;
    const guess = GUESS_BY_QUESTION_TYPE[questionType];
    // An unknown format is treated as the most guessable one we know about
    // rather than the least — an unrecognised type must not buy a bigger head
    // start than a recognised one.
    const floor = typeof guess === 'number' ? guess : Math.max(...Object.values(GUESS_BY_QUESTION_TYPE));
    if (floor >= MAX_GUESSABLE) return 0;
    return Math.min(PLACEMENT_CEILING, base * (1 - floor));
}

// ---- the curriculum as a sequence ------------------------------------------

/**
 * A project's leaves in curriculum order, with the top-level phase each one
 * belongs to.
 *
 * Built in JS rather than as a recursive CTE because "leaf" here has to mean
 * exactly what `LEAF_NODE` in server/today.js means — a non-note node with no
 * non-note children, so a topic whose only children are notes is still a leaf —
 * and that definition is easier to state once over an in-memory tree than to
 * keep in step inside a recursive query. Curricula are thousands of rows.
 *
 * Order is depth-first by `position`, which is the order the curriculum is
 * written in and therefore the order the propagation model assumes is roughly
 * easy-to-hard.
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
 * Leaves a probe may ask about: still open, and not already measured.
 *
 * "Already measured" is any mastery evidence at all, not just a passing one — a
 * topic the learner has answered anything on has a real estimate, and a probe
 * result must never overwrite measurement with inference.
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
 * positions inside each.
 *
 * Two properties matter and neither survives "just take the first N leaves":
 * every phase that can be sampled is (a probe that never asks about the second
 * half of the course cannot tell you anything about the second half of the
 * course), and within a phase the picks are spread rather than clustered, so
 * the sample straddles the easy-to-hard gradient the propagation model relies
 * on.
 *
 * Apportionment is floor-one-per-phase while the budget allows, then largest
 * remainder by candidate count. When there are more phases than slots, the
 * phases themselves are sampled evenly — the same spread rule one level up.
 * Deterministic throughout: the same curriculum yields the same probe.
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
        // More phases than questions: sample the phases evenly and give each
        // chosen one a single slot.
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
            // Largest remainder, ties broken by curriculum order (`shares` is
            // already in phase order and sort is stable) so the result is
            // reproducible rather than merely correct.
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

    // Even spreading can land twice on the same leaf in a short pool; dedupe
    // and return in curriculum order, which is the order they are asked.
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

    // The topics actually asked about. A wrong answer seeds nothing — it is not
    // a penalty (an unseeded topic starts at 0.0, exactly as it would without a
    // probe), it is the absence of a head start.
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

    // The topics an answer vouches for. Nearest probe on each side WITHIN THE
    // SAME top-level section; a correct one at or after seeds, a wrong one at
    // or before blocks, and a conflict resolves to no seed. The section scope
    // is what keeps the prefix model honest on an anthology project — see the
    // header. A probe whose own leaf has since been deleted has no section and
    // vouches for nothing rather than for everything.
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
 * Whether a probe is worth offering, and if not, why — as an ANSWER rather than
 * an error, the same contract the atlas uses. "Too small to place" and "already
 * measured" are both correct states of a healthy project.
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
 * Open a probe row before generation starts, so a learner who reloads the page
 * mid-generation finds their probe rather than starting a second one.
 * Re-taking withdraws the previous probe's seeds first (see `withdrawPlacement`).
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
 * Re-deriving rather than incrementally adding matters: a later answer can
 * *withdraw* an earlier one's implication (a wrong answer at position k blocks
 * everything after k, including topics an earlier correct answer had already
 * vouched for), and an incremental seeder has no way to take that back. Cheap
 * — the whole computation is arithmetic over a few thousand leaves.
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

    // The answer is real evidence: the learner answered it. Recorded so the
    // history is honest — and deliberately NOT part of the gate's raw-score
    // clause (see VALID_EVIDENCE_TYPES), because one question per topic can
    // never be an assessment.
    try {
        recordPlacementEvidence(question.node_id, !!correct, question.type);
    } catch (err) {
        console.error('[Placement] failed to record evidence:', err.message);
    }

    return applyProbeSeeds(probe.projectId, { ...probe, answers });
}

/**
 * Evidence for a probe answer, written WITHOUT running the BKT update.
 *
 * `updateMasteryFromAttempt` would climb the estimate from wherever the seed
 * put it, so a seeded 0.41 plus its own correct answer lands near 0.8 — one
 * multiple-choice question carrying a topic most of the way to the threshold,
 * which is exactly what the ceiling exists to prevent. The seed IS this
 * answer's contribution to the estimate; running BKT on top would count it
 * twice.
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

    // Topics with evidence from anything other than this probe are measured and
    // must not be seeded. The probe's own placement rows are excluded, or a
    // topic would become ineligible for the seed its own answer just earned.
    const measured = new Set(db.prepare(`
        SELECT DISTINCT me.node_id
        FROM mastery_evidence me
        JOIN nodes n ON n.id = me.node_id
        WHERE n.project_id = ? AND me.evidence_type != 'placement'
    `).all(projectId).map(r => r.node_id));

    const seeds = computeSeeds(sequence, results, measured);

    // Withdraw first, then write: a re-derivation that only adds would leave a
    // stale seed standing on a topic a later wrong answer has since blocked.
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
 * Clear placement seeds across a project.
 *
 * Only ever touches rows that are still purely seeded — `applySeededPrior`
 * refuses a node with real attempts — and leaves any transfer seed on the same
 * node standing, because the score is recomputed from both columns.
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
 * Discard a probe and everything it seeded. The learner's escape hatch: a probe
 * they disagree with must be fully reversible, or the honest move (taking it)
 * carries a risk the dishonest move (skipping it) does not.
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
        // The honest headline. Not "you already know 40 topics" — a seeded
        // estimate is a starting point, and the gate still wants proof.
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
// One question per target, through the SAME gates a feed question passes: the
// mechanical `questionDefects` check and then the cold-solve verifier. The
// stakes argue for it more strongly here than in the feed, not less. A feed
// question that marks a right answer wrong costs one BKT update the learner
// watches happen; a probe question with a broken key silently decides how much
// of a topic — and, through propagation, of a whole stretch of the course —
// gets taught. The learner never sees the connection, because the consequence
// is material that quietly does not appear.
//
// A target whose question cannot be authored soundly is DROPPED rather than
// served, which shortens the probe. That is the right failure: a probe with ten
// good questions measures ten topics, while one with twelve questions two of
// which are broken mismeasures the course.

const AUTHOR_ATTEMPTS = 2;
const MAX_CONSECUTIVE_TRANSPORT_FAILURES = 2;

// Open answers are much stronger evidence than multiple choice (guess floor
// 0.05 against 0.25) and cost an AI grading call each, so a probe MIXES them
// rather than choosing: every third question is open. That keeps the median
// probe cheap while stopping the whole estimate from resting on the format a
// learner can quarter-guess.
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

    // A true/false slipping through would seed nothing (`priorFromAnswer`
    // refuses it) but would still spend a slot and leave its topic measured at
    // zero, so it is refused here too rather than left to fail quietly later.
    if (q.type === 'true_false') return null;

    const defects = questionDefects(q, nodeId);
    if (defects.length) return { rejected: defects.join('; ') };
    return q;
}

/**
 * Author one probe question for one target.
 *
 * Returns the question, `null` when it could not be written soundly, or
 * `{transportError}` when the model could not be reached at all — three
 * outcomes, not two, because the caller must treat "this question is bad" and
 * "the model is not answering" completely differently. Never throws for content
 * reasons; only an abort propagates.
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
            // `operation: 'authoring'` buys the 300s budget the other background
            // authors already use. Measured against the local llama-swap model
            // on this box: three of four targets blew the 120s DEFAULT and were
            // dropped, so a probe on a thinking local model was authoring one
            // question in sixteen minutes.
            const resp = await generateResponse(user, system, [], {
                temperature: 0.4, signal, operation: 'authoring',
            });
            const match = resp.match(/\{[\s\S]*\}/);
            if (!match) { priorFault = 'the reply contained no JSON object'; continue; }
            parsed = parseJsonWithRepair(escapeLatexBackslashes(match[0]));
        } catch (err) {
            if (err?.name === 'AbortError') throw err;
            // A transport failure is NOT a content failure, and must not be
            // retried like one. Re-issuing the identical prompt after a timeout
            // carries no new instruction (the whole point of `priorFault`) and
            // simply pays the timeout twice — which is exactly what the first
            // real run did: 2 x 120s per dropped target, for nothing.
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
            // `available: false` means the verifier could not be REACHED, which
            // degrades to serving — the rule every model-dependent gate here
            // follows. Recorded rather than collapsed into `ok`, because a probe
            // authored during an outage must be legible as unverified afterwards
            // instead of indistinguishable from a checked one.
            verified: verdict.available === true,
        };
    }
    console.warn(`[Placement] dropped target "${target.title}": ${priorFault}`);
    return null;
}

/**
 * Author every question for a probe, in curriculum order, reporting progress.
 *
 * Serial by design: a local model is usually single-slot, so parallel authoring
 * buys contention rather than throughput — the same reason `embeddings.js` and
 * `feedGen.js` each run one chain.
 */
export async function generateProbeQuestions(probe, { emit, signal } = {}) {
    const lang = getProjectLanguage(probe.projectId);
    const questions = [];
    // Same rule as tools/quiz-audit.mjs: a run that reports a verdict over a
    // batch must not keep grinding once the model has stopped answering. Two
    // consecutive transport failures on a 300s budget is ten minutes of nothing,
    // and the twelve-question probe behind it would be an hour.
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
 * Graded on the server for the same reason the question's format is read from
 * the stored row rather than the request: this verdict decides how much of the
 * course gets taught, so it may not be something the learner's browser asserts.
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
