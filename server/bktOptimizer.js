// server/bktOptimizer.js — fit the learner's own BKT rates to their evidence.
//
// `p_T` (how much one attempt teaches) and `p_S` (how often a known thing is
// still answered wrong) are constants in mastery.js, hand-set for nobody in
// particular. The guess floors stay per FORMAT (they are a property of the
// item, not the learner); these two are properties of the learner, and the
// evidence table is a record of exactly the observations they predict — so
// they can be fitted, the same way the FSRS parameters are (fsrsOptimizer.js):
//
//   * the objective is the log-likelihood of every recorded attempt given the
//     estimate the engine held just before it, replaying each topic's history
//     with the SAME update rules the app uses (mastery.js exports them, with
//     rate overrides, so nothing is re-implemented here);
//   * the search is a grid, not a gradient — two bounded parameters, a few
//     hundred attempts: 400 evaluations cost milliseconds and cannot get stuck;
//   * a fit is ACCEPTED only when it beats the defaults on the latest 20% of
//     attempts by date, which it never saw. One learner's evidence is small
//     and a fit that merely memorises it would make the estimate worse.
//
// The combinatorial factor of a batch attempt (C(n,k)) is dropped from the
// likelihood: it does not depend on the parameters, so it cancels in every
// comparison this module makes. The "loss" is therefore comparable between
// parameter sets on the same data and not across data sets.
//
// Seeded priors (transfer, placement) are not replayed: the replay starts every
// topic cold. That understates the prior on a handful of topics and is the
// honest simplification — the alternative is reconstructing what the
// neighbour-space looked like at each moment in the past.

import db from './database.js';
import {
    bktUpdate, bktBatchUpdate, BKT_PARAMS, BKT_FIT_BOUNDS, GUESS_BY_QUESTION_TYPE, MIN_GATE_QUESTIONS,
} from './mastery.js';

/** Attempts (evidence rows) needed before a fit is attempted at all. */
export const MIN_FIT_ATTEMPTS = 100;
export const HOLDOUT_SHARE = 0.2;
const EPS = 1e-9;

/** Per-topic attempt sequences from mastery_evidence, in time order. */
export function loadAttemptSequences() {
    const rows = db.prepare(`
        SELECT node_id, score, total, metadata, created_at, id
        FROM mastery_evidence
        WHERE evidence_type != 'placement' AND total >= 1 AND score >= 0 AND score <= total
        ORDER BY node_id, created_at, id
    `).all();
    const out = [];
    let cur = null;
    for (const r of rows) {
        let p_G;
        try { p_G = GUESS_BY_QUESTION_TYPE[JSON.parse(r.metadata || '{}').questionType]; } catch { p_G = undefined; }
        const t = Date.parse(String(r.created_at).replace(' ', 'T') + (String(r.created_at).endsWith('Z') ? '' : 'Z'));
        if (!cur || cur.nodeId !== r.node_id) { cur = { nodeId: r.node_id, attempts: [] }; out.push(cur); }
        cur.attempts.push({ t: Number.isFinite(t) ? t : 0, score: r.score, total: r.total, p_G });
    }
    return out;
}

/**
 * Mean negative log-likelihood of the attempts in [from, to), replaying each
 * topic from cold with the given rates. Mirrors updateMasteryFromAttempt: an
 * assessment (>= MIN_GATE_QUESTIONS) is one binomial observation from
 * max(state, p_L0) on a topic never measured, else from the state; anything
 * shorter is answered one question at a time from the state.
 */
export function evaluate(params, sequences, { from = -Infinity, to = Infinity } = {}) {
    const { p_T, p_S } = params;
    let loss = 0, n = 0;
    for (const seq of sequences) {
        let state = 0;
        let measured = false;
        for (const a of seq.attempts) {
            const p_G = typeof a.p_G === 'number' ? a.p_G : BKT_PARAMS.p_G;
            const counted = a.t >= from && a.t < to;
            if (a.total >= MIN_GATE_QUESTIONS) {
                const prior = Math.max(BKT_PARAMS.p_K_MIN, measured ? state : Math.max(state, BKT_PARAMS.p_L0));
                const k = a.score, w = a.total - a.score;
                const lk = k * Math.log(1 - p_S) + w * Math.log(p_S);
                const ln = k * Math.log(p_G) + w * Math.log(1 - p_G);
                const m = Math.max(lk, ln);
                const mix = prior * Math.exp(lk - m) + (1 - prior) * Math.exp(ln - m);
                if (counted) { loss += -(Math.log(Math.max(mix, EPS)) + m); n++; }
                state = bktBatchUpdate(prior, a.score, a.total, { p_G, p_T, p_S });
            } else {
                for (let i = 0; i < a.total; i++) {
                    const correct = i < a.score;
                    const pc = state * (1 - p_S) + (1 - state) * p_G;
                    if (counted) { loss += -Math.log(Math.max(correct ? pc : 1 - pc, EPS)); n++; }
                    state = bktUpdate(state, correct, { p_G, p_T, p_S }).p_K_posterior;
                }
            }
            measured = true;
        }
    }
    return { loss: n ? loss / n : NaN, n };
}

export function holdoutCutoff(sequences, share = HOLDOUT_SHARE) {
    const times = [];
    for (const seq of sequences) for (const a of seq.attempts) times.push(a.t);
    if (!times.length) return Infinity;
    times.sort((a, b) => a - b);
    return times[Math.min(times.length - 1, Math.max(0, Math.floor(times.length * (1 - share))))];
}

function grid(lo, hi, step) {
    const out = [];
    for (let v = lo; v <= hi + 1e-12; v += step) out.push(Number(v.toFixed(4)));
    return out;
}

/** Fit. `{ accepted, params, stats, reason }`; `params` are the defaults unless accepted. */
export function fit(sequences, { minAttempts = MIN_FIT_ATTEMPTS } = {}) {
    const started = Date.now();
    const defaults = { p_T: BKT_PARAMS.p_T, p_S: BKT_PARAMS.p_S };
    const cutoff = holdoutCutoff(sequences);
    const train = { to: cutoff }, val = { from: cutoff };
    const base = evaluate(defaults, sequences, train);
    const baseVal = evaluate(defaults, sequences, val);
    const attempts = sequences.reduce((a, s) => a + s.attempts.length, 0);
    const stats = {
        topics: sequences.length, attempts,
        trainAttempts: base.n, valAttempts: baseVal.n,
        trainDefault: base.loss, valDefault: baseVal.loss,
        trainFitted: null, valFitted: null, evaluations: 0, ms: 0,
    };
    if (attempts < minAttempts) {
        stats.ms = Date.now() - started;
        return { accepted: false, params: defaults, stats, reason: `needs at least ${minAttempts} recorded attempts to fit on (have ${attempts})` };
    }
    const [tLo, tHi] = BKT_FIT_BOUNDS.p_T, [sLo, sHi] = BKT_FIT_BOUNDS.p_S;
    let best = { params: defaults, loss: base.loss };
    const consider = (p_T, p_S) => {
        const { loss } = evaluate({ p_T, p_S }, sequences, train);
        stats.evaluations++;
        if (loss < best.loss - 1e-9) best = { params: { p_T, p_S }, loss };
    };
    for (const p_T of grid(tLo, tHi, 0.02)) for (const p_S of grid(sLo, sHi, 0.02)) consider(p_T, p_S);
    // Refine around the coarse optimum.
    const c = best.params;
    for (const p_T of grid(Math.max(tLo, c.p_T - 0.02), Math.min(tHi, c.p_T + 0.02), 0.005)) {
        for (const p_S of grid(Math.max(sLo, c.p_S - 0.02), Math.min(sHi, c.p_S + 0.02), 0.005)) consider(p_T, p_S);
    }
    const fittedVal = evaluate(best.params, sequences, val);
    stats.trainFitted = best.loss;
    stats.valFitted = fittedVal.loss;
    stats.ms = Date.now() - started;
    const accepted = Number.isFinite(fittedVal.loss) && baseVal.n > 0
        && fittedVal.loss < baseVal.loss - 1e-4 && best.loss < base.loss;
    return {
        accepted,
        params: accepted ? best.params : defaults,
        stats,
        reason: accepted ? null : 'the fitted rates did not beat the defaults on held-out attempts, so the defaults were kept',
    };
}
