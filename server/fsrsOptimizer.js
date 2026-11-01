// server/fsrsOptimizer.js — fit FSRS-7 parameters to ONE learner's review log.
//
// The scheduler (src/utils/srs.ts) runs FSRS-7 with the published default
// 34-parameter vector, which is a population average: the benchmark that ships
// it reports a lower loss once the parameters are fitted per collection. This
// module is the "per-user" half, built here rather than taken from npm for one
// reason that matters to this project: the forward model (what a rating does to
// a card's memory state, and what the recall probability is after t days) is
// deliberately NOT re-implemented — it is `ts-fsrs`'s own `FSRS7Algorithm`, the
// same MIT-licensed code the scheduler already depends on, so the fit can never
// drift from what the scheduler will then do with the result. Only the fitting
// is ours: a log-loss objective over the learner's own reviews, minimised by
// Adam on a numeric gradient, shrunk toward the defaults, and ACCEPTED only when
// it beats the defaults on reviews it was not fitted on.
//
// What is fitted on: every review moves the card's state, same-day steps
// included (`elapsed` is fractional days), and the loss is scored on the FIRST
// review of each UTC day that has a review before it — the day-level
// observations of forgetting (server/reviewLog.js says why).
//
// Why numeric gradients: 34 parameters and a few thousand reviews. A central
// difference costs 68 forward passes per step — and it stays correct when
// ts-fsrs changes a formula, which an analytic gradient written here would not.
//
// Why shrinkage: one learner has hundreds of reviews, not the hundreds of
// thousands the reference optimiser sees. An L2 penalty toward the published
// vector, scaled by 1/N, lets a small log move the parameters it has evidence
// about and leaves the rest where the population put them. It vanishes as the
// log grows.
//
// Why a hold-out: on small collections the defaults sometimes WIN, because the
// fit generalises badly. So the last 20% of scored reviews by date are never
// fitted on, and a result that does not beat the defaults there is reported and
// NOT applied — the learner keeps the defaults and is told why. Pure
// computation, no model calls, no database: the caller hands over sequences
// (server/reviewLog.js) and stores what comes back.

import {
    FSRS7Algorithm, FSRS7_DEFAULT_WEIGHTS, FSRS7_MODEL_BOUNDS, clipFSRS7Parameters,
} from 'ts-fsrs/models/fsrs-7';

export const DEFAULT_W = Object.freeze([...FSRS7_DEFAULT_WEIGHTS]);
export const PARAM_COUNT = DEFAULT_W.length;
/** Scored reviews (first of a day, with a review before them) needed to fit at all. */
export const MIN_FIT_REVIEWS = 100;
/** Share of scored reviews, latest by date, kept back for validation. */
export const HOLDOUT_SHARE = 0.2;

const EPS = 1e-6;
const clampP = (p) => Math.min(1 - EPS, Math.max(EPS, p));

const algorithmFor = (w) => new FSRS7Algorithm([...w], FSRS7_MODEL_BOUNDS);

/** Clip a candidate vector into the ranges ts-fsrs itself enforces. */
export function clipW(w) {
    return clipFSRS7Parameters([...w]);
}

/**
 * A usable FSRS-7 vector: 34 finite weights already inside ts-fsrs's bounds (the
 * same test the client's `configureSrs` applies). A stored FSRS-6 vector has 21
 * and is not one; it cannot be converted, only refitted.
 */
export function isValidW(w) {
    return Array.isArray(w) && w.length === PARAM_COUNT && w.every(v => Number.isFinite(v))
        && clipW(w).every((v, i) => v === w[i]);
}

/** Is this the review the loss scores? (A day's first, with a state before it.) */
const scored = (rv, i) => i > 0 && rv.firstOfDay;

/**
 * Walk every sequence through FSRS-7 at `w`, calling `visit(review, r)` with
 * the predicted recall of each scored review.
 */
function replay(w, sequences, visit) {
    const alg = algorithmFor(w);
    for (const seq of sequences) {
        let state = null;
        seq.reviews.forEach((rv, i) => {
            if (state && scored(rv, i)) visit(rv, clampP(alg.curve(rv.elapsed, state).retrievability));
            state = alg.next_state(state, state ? rv.elapsed : 0, rv.rating);
        });
    }
}

/** How many reviews the loss scores — the count `MIN_FIT_REVIEWS` is about. */
export function scoredReviewCount(sequences) {
    let n = 0;
    for (const seq of sequences) seq.reviews.forEach((rv, i) => { if (scored(rv, i)) n++; });
    return n;
}

/**
 * Mean log-loss of predicted recall over the scored reviews, optionally
 * restricted to a time window [from, to).
 *
 * @param {number[]} w
 * @param {Array<{reviews: Array<{t:number, elapsed:number, rating:number, firstOfDay:boolean}>}>} sequences
 */
export function evaluate(w, sequences, { from = -Infinity, to = Infinity } = {}) {
    let loss = 0, n = 0;
    replay(w, sequences, (rv, r) => {
        if (rv.t < from || rv.t >= to) return;
        loss += rv.rating > 1 ? -Math.log(r) : -Math.log(1 - r);
        n++;
    });
    return { loss: n ? loss / n : NaN, n };
}

/** Every scored review with its predicted recall probability and what happened. */
export function predictReviews(w, sequences) {
    const out = [];
    replay(w, sequences, (rv, r) => out.push({ t: rv.t, r, recalled: rv.rating > 1 }));
    return out;
}

/**
 * Observed retention against predicted recall, binned by prediction — the
 * calibration readout. `observed` is the share of scored reviews answered
 * correctly (rating > Again), which IS retention; `expected` is what the
 * scheduler thought it would be. A bin whose observed rate sits well under
 * its predicted centre is the scheduler over-promising at that recall level.
 */
export function retentionReport(w, sequences, binCount = 10) {
    const preds = predictReviews(w, sequences);
    const bins = Array.from({ length: binCount }, (_, i) => ({ lo: i / binCount, hi: (i + 1) / binCount, n: 0, sumPred: 0, sumObs: 0 }));
    let recalled = 0, sumPred = 0;
    for (const p of preds) {
        const b = bins[Math.min(binCount - 1, Math.floor(p.r * binCount))];
        b.n++; b.sumPred += p.r; b.sumObs += p.recalled ? 1 : 0;
        if (p.recalled) recalled++;
        sumPred += p.r;
    }
    return {
        reviews: preds.length,
        recalled,
        observed: preds.length ? recalled / preds.length : null,
        expected: preds.length ? sumPred / preds.length : null,
        bins: bins.filter(b => b.n > 0).map(b => ({
            lo: b.lo, hi: b.hi, n: b.n,
            predicted: b.sumPred / b.n,
            observed: b.sumObs / b.n,
        })),
    };
}

/** Timestamp cutting the scored reviews into the earliest (1-share) and the latest share. */
export function holdoutCutoff(sequences, share = HOLDOUT_SHARE) {
    const times = [];
    for (const seq of sequences) seq.reviews.forEach((rv, i) => { if (scored(rv, i)) times.push(rv.t); });
    if (!times.length) return Infinity;
    times.sort((a, b) => a - b);
    const idx = Math.min(times.length - 1, Math.max(0, Math.floor(times.length * (1 - share))));
    return times[idx];
}

/**
 * Fit. Returns `{ accepted, w, stats, reason? }`; `w` is only meaningful when
 * accepted. `onProgress({step, loss})` is called once per step.
 */
export function fit(sequences, {
    steps = 200, lr = 0.05, minReviews = MIN_FIT_REVIEWS, onProgress = null, patience = 20,
} = {}) {
    const started = Date.now();
    const w0 = [...DEFAULT_W];
    const cutoff = holdoutCutoff(sequences);
    const train = { to: cutoff };
    const val = { from: cutoff };

    const base = evaluate(w0, sequences, train);
    const baseVal = evaluate(w0, sequences, val);
    const stats = {
        cards: sequences.length,
        reviews: sequences.reduce((a, s) => a + s.reviews.length, 0),
        predicted: base.n + baseVal.n,
        trainReviews: base.n,
        valReviews: baseVal.n,
        trainDefault: base.loss,
        valDefault: baseVal.loss,
        trainFitted: null,
        valFitted: null,
        steps: 0,
        ms: 0,
    };
    if (base.n < minReviews) {
        stats.ms = Date.now() - started;
        return {
            accepted: false, w: w0, stats,
            reason: `needs at least ${minReviews} day-level reviews with a prior state to fit on (have ${base.n})`,
        };
    }

    // Per-parameter scale: the vector spans four orders of magnitude, so both
    // the step size and the finite-difference width follow each parameter's
    // own magnitude rather than one global number.
    const scale = w0.map(v => Math.max(Math.abs(v), 0.05));
    const lambda = 2 / base.n;
    const objective = (w) => {
        const { loss } = evaluate(w, sequences, train);
        let pen = 0;
        for (let i = 0; i < w.length; i++) { const d = (w[i] - w0[i]) / scale[i]; pen += d * d; }
        return loss + lambda * pen;
    };

    let w = [...w0];
    const m = new Array(w.length).fill(0);
    const v = new Array(w.length).fill(0);
    const b1 = 0.9, b2 = 0.999;
    let best = { obj: objective(w), w: [...w] };
    let sinceBest = 0;

    for (let step = 1; step <= steps; step++) {
        const grad = new Array(w.length);
        for (let i = 0; i < w.length; i++) {
            const h = 1e-3 * scale[i];
            const up = [...w]; up[i] += h;
            const dn = [...w]; dn[i] -= h;
            grad[i] = (objective(clipW(up)) - objective(clipW(dn))) / (2 * h);
        }
        for (let i = 0; i < w.length; i++) {
            m[i] = b1 * m[i] + (1 - b1) * grad[i];
            v[i] = b2 * v[i] + (1 - b2) * grad[i] * grad[i];
            const mh = m[i] / (1 - Math.pow(b1, step));
            const vh = v[i] / (1 - Math.pow(b2, step));
            w[i] -= lr * scale[i] * mh / (Math.sqrt(vh) + 1e-8);
        }
        w = clipW(w);
        const obj = objective(w);
        stats.steps = step;
        if (obj < best.obj - 1e-6) { best = { obj, w: [...w] }; sinceBest = 0; }
        else if (++sinceBest >= patience) break;
        if (onProgress) onProgress({ step, loss: obj, best: best.obj });
    }

    // Rounded for storage, then clipped once more so the stored vector passes
    // `isValidW` (and the client's bounds check) exactly as written.
    const fittedW = clipW(best.w.map(x => Number(x.toFixed(6))));
    const fitted = evaluate(fittedW, sequences, train);
    const fittedVal = evaluate(fittedW, sequences, val);
    stats.trainFitted = fitted.loss;
    stats.valFitted = fittedVal.loss;
    stats.ms = Date.now() - started;

    // Accept only a fit that generalises: better on the held-out reviews, not
    // merely on the ones it was tuned to. Equal-within-noise counts as "no".
    const accepted = Number.isFinite(fittedVal.loss)
        && fittedVal.loss < baseVal.loss - 1e-4
        && fitted.loss < base.loss;
    return {
        accepted,
        w: accepted ? fittedW : w0,
        stats,
        reason: accepted ? null : 'the fitted parameters did not beat the defaults on held-out reviews, so the defaults were kept',
    };
}
