// Spaced-repetition scheduling — FSRS-7, the newest FSRS, via `ts-fsrs` 6.
//
// The one scheduler behind every review surface (`FlashcardView`,
// `GlobalFlashcardReview`, `FlashcardFeedCard`), which call `computeSrsUpdate`,
// `computeNextInterval` and `formatInterval`.
//
// FSRS models each card's memory and schedules the next review where predicted
// recall falls to `REQUEST_RETENTION` (0.9). FSRS-7 keeps TWO traces per card, a
// slow one (`stability`) and a fast one (`stability_fast`) that a same-day step
// strengthens, mixed into one forgetting curve; so a 10-minute relearning step now
// counts as evidence instead of being thrown away. The published "20–30% fewer
// reviews than SM-2" assumes parameters fitted on the learner's own log; it is not
// measured on this app, so do not quote it as ours. The published FSRS-7 defaults
// ship until `server/fsrsOptimizer.js` fits a vector that beats them.
//
// Not a hand-rolled copy: `ts-fsrs` is the open-spaced-repetition project's own
// implementation (MIT), a port of fsrs-rs.
//
// Configuration:
// - `enableShortTerm: true` with `learningSteps` `1m, 10m` and `relearningSteps`
//   `10m` (Anki's, and ts-fsrs's defaults): a new card walks 1m → 10m, Again on a
//   mature card goes 10 minutes into Relearning. "Again" means "shortly".
// - `allowModelOverride: false` — the ladder is the ladder. ts-fsrs turns it on for
//   FSRS-7, which lets the model stretch a 10-minute step or graduate a card early;
//   off, every learner sees the same 1m / 10m steps the labels promise.
// - `fractionalDays: true` — elapsed time is measured to the second, so the fast
//   trace sees a 10-minute step as 10 minutes rather than as "the same day, 0".
// - `enableFuzz: false` — the feed already caps reviews per day, so fuzz's pile-up
//   protection is moot, and determinism lets `tools/srs-gates.mjs` assert scheduling.
//
// Columns:
// - `stability`, `stability_fast`, `fsrs_difficulty`: the FSRS-7 memory state. A
//   card with `stability` but no `stability_fast` was last scheduled by FSRS-6 (or
//   by an older client); `memoryStateOf` SEEDS its FSRS-7 state on read, never
//   resets it. Nothing is written until the card is next reviewed, so every stored
//   due date stays exactly where it was.
// - `difficulty`: 0–5, higher = harder, DERIVED from FSRS difficulty (1–10); the
//   dashboard counts `>= 3` as weak.
// - `last_interval`: whole days to the next review, 0 on a sub-day step (read as
//   "learning" by `cardState()` in server/deckStructure.js, exported by Anki as
//   new). `ease_factor` (SM-2) is not written; it is read once to migrate a
//   pre-FSRS card.

import {
    defineScheduler, dateChrono, Rating, State,
    schedulerDesiredRetentionMiddleware, schedulerFuzzingMiddleware, schedulerStatsMiddleware,
    schedulerScheduledDaysMiddleware, schedulerLearningStepsMiddleware,
    schedulerMaximumIntervalMiddleware, schedulerMonotonicIntervalMiddleware,
} from 'ts-fsrs';
import {
    FSRS7Model, FSRS7Algorithm, FSRS7_DEFAULT_WEIGHTS, FSRS7_MODEL_BOUNDS, checkFSRS7Parameters,
    type FSRS7State,
} from 'ts-fsrs/models/fsrs-7';
import type { TFunction } from 'i18next';

export type ReviewRating = 'again' | 'hard' | 'good' | 'easy';

/** Target probability of recall at the moment a card comes up. */
export const REQUEST_RETENTION = 0.9;

/** Legacy SM-2 default, kept only so a pre-FSRS card can be migrated. */
export const DEFAULT_EASE = 2.5;
const MIN_EASE = 1.3;

/** How many weights an FSRS-7 vector has. A stored FSRS-6 vector has 21. */
export const FSRS_WEIGHT_COUNT = 34;

/** The (re)learning ladders, in ts-fsrs's `<number><m|h|d>` notation. */
export const LEARNING_STEPS = ['1m', '10m'] as const;
export const RELEARNING_STEPS = ['10m'] as const;

/** FSRS `State`, re-exported so callers need not import ts-fsrs to name one. */
export const CARD_STATE = {
    new: State.New,
    learning: State.Learning,
    review: State.Review,
    relearning: State.Relearning,
} as const;

/**
 * True while a card is on a (re)learning ladder, i.e. it comes back within the
 * session rather than on a later day.
 */
export function isInLearning(state: number | null | undefined): boolean {
    return state === State.Learning || state === State.Relearning;
}

const definition = defineScheduler({ model: FSRS7Model, chrono: dateChrono }).use(
    schedulerDesiredRetentionMiddleware, schedulerFuzzingMiddleware, schedulerStatsMiddleware,
    schedulerScheduledDaysMiddleware, schedulerLearningStepsMiddleware,
    schedulerMaximumIntervalMiddleware, schedulerMonotonicIntervalMiddleware,
);

function buildScheduler(weights: readonly number[]) {
    return definition.create({
        config: {
            weights: [...weights],
            fractionalDays: true,
            enableShortTerm: true,
            desiredRetention: REQUEST_RETENTION,
            learningSteps: [...LEARNING_STEPS],
            relearningSteps: [...RELEARNING_STEPS],
            allowModelOverride: false,
            enableFuzz: false,
            maximumInterval: 36500,
            clearStatsOnForget: false,
        },
    });
}

type Scheduler = ReturnType<typeof buildScheduler>;
type SchedulerCard = ReturnType<Scheduler['newCard']>;

/** The 34-weight FSRS-7 vector in use: `null` = the published defaults. */
let activeW: number[] | null = null;
let scheduler: Scheduler = buildScheduler(FSRS7_DEFAULT_WEIGHTS);
let algorithm = new FSRS7Algorithm(FSRS7_DEFAULT_WEIGHTS, FSRS7_MODEL_BOUNDS);

/**
 * Switch the scheduler to a fitted parameter vector, or back to the defaults.
 *
 * The vector is the `fsrs_params` setting (written by server/fsrsOptimizer.js once
 * it beats the defaults on held-out reviews), applied on every settings load. An
 * invalid vector (wrong length, a NaN, a weight outside its bounds) falls back to the
 * defaults: one corrupt weight schedules confidently and wrongly. A 21-weight
 * vector fitted for FSRS-6 is invalid here; it cannot be converted, only refitted.
 */
export function configureSrs({ w = null }: { w?: number[] | null } = {}): void {
    let valid = Array.isArray(w) && w.length === FSRS_WEIGHT_COUNT
        && w.every(v => typeof v === 'number' && Number.isFinite(v))
        ? [...w] : null;
    if (JSON.stringify(valid) === JSON.stringify(activeW)) return;
    let next: Scheduler;
    try {
        // Outside the model's bounds (ts-fsrs clips nothing here): a negative
        // weight schedules until a review throws.
        if (valid) checkFSRS7Parameters(valid);
        next = buildScheduler(valid ?? FSRS7_DEFAULT_WEIGHTS);
    } catch {
        valid = null;
        next = buildScheduler(FSRS7_DEFAULT_WEIGHTS);
    }
    activeW = valid;
    scheduler = next;
    algorithm = new FSRS7Algorithm(valid ?? FSRS7_DEFAULT_WEIGHTS, FSRS7_MODEL_BOUNDS);
}

const RATING_MAP: Record<ReviewRating, typeof Rating.Again | typeof Rating.Hard | typeof Rating.Good | typeof Rating.Easy> = {
    again: Rating.Again,
    hard: Rating.Hard,
    good: Rating.Good,
    easy: Rating.Easy,
};

/** What a stored flashcard row looks like to the scheduler. */
export interface CardSrsState {
    // FSRS state — null on a card that has never been reviewed under FSRS.
    stability?: number | null;
    /** FSRS-7's fast trace; null on a card last scheduled by FSRS-6 or earlier. */
    stability_fast?: number | null;
    fsrs_difficulty?: number | null;
    state?: number | null;
    lapses?: number | null;
    /** The card's rung on the (re)learning ladder. Persisted because FSRS's next
     *  step depends on it (Good on step 1 of `1m, 10m` graduates; on step 0 it
     *  moves to 10m); dropping it restarts the ladder on every reload. */
    learning_steps?: number | null;
    // Shared / legacy columns.
    last_interval?: number | null;
    ease_factor?: number | null;
    difficulty?: number | null;
    review_count?: number | null;
    last_reviewed?: string | null;
    next_review?: string | null;
}

export interface SrsUpdate {
    /** The rating, 1-4. Not a card column: the endpoint appends it to the review
     *  log (server/reviewLog.js), which the optimiser and retention read. */
    rating: number;
    stability: number;
    stability_fast: number;
    fsrs_difficulty: number;
    state: number;
    lapses: number;
    learning_steps: number;
    last_interval: number;   // whole days, 0 on a sub-day step (read as
                             // "learning" by `cardState()` in
                             // server/deckStructure.js, exported by Anki as new).
    difficulty: number;      // app-wide 0-5 convention, derived from FSRS D
    last_reviewed: string;   // ISO timestamp
    next_review: string;     // ISO timestamp
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const clampS = (v: number) => clamp(v, FSRS7_MODEL_BOUNDS.sMin, FSRS7_MODEL_BOUNDS.sMax);
const clampD = (v: number) => clamp(v, FSRS7_MODEL_BOUNDS.dMin, FSRS7_MODEL_BOUNDS.dMax);

/**
 * FSRS difficulty (1–10) → the app's 0–5 "higher = harder" scale, linear over the
 * full range, so the dashboard's `difficulty >= 3` reads the hardest 40% as weak.
 */
export function appDifficultyFromFsrs(d: number): number {
    return clamp(Math.round(((d - 1) / 9) * 5), 0, 5);
}

/**
 * SM-2 ease (1.3 … ~2.5+) → an FSRS difficulty estimate (1–10).
 *
 * Used once per card, to migrate from SM-2. Ease 2.5 (the default) lands mid-scale,
 * the 1.3 floor at maximum difficulty, anything above 2.5 below the middle.
 */
function fsrsDifficultyFromEase(ease: number): number {
    const e = Math.max(MIN_EASE, ease);
    return clamp(10 - ((e - MIN_EASE) / (DEFAULT_EASE - MIN_EASE)) * 5, 1, 10);
}

/**
 * The fast/slow ratio of a typical FSRS-7 card, by the interval it has earned:
 * a card of difficulty `d` walked through this app's ladder (Good on each step,
 * then Good on each due date, whole-day intervals). Points are (interval, ratio).
 */
function typicalTrajectory(d: number): { interval: number; logRatio: number }[] {
    let state: FSRS7State = { ...algorithm.next_state(null, 0, Rating.Good), difficulty: d };
    state = algorithm.next_state(state, 10 / 1440, Rating.Good);
    const points: { interval: number; logRatio: number }[] = [];
    for (let k = 0; k < 40; k++) {
        const interval = algorithm.next_interval(state, REQUEST_RETENTION);
        points.push({ interval, logRatio: Math.log(state.stabilityFast / state.stability) });
        if (!(interval > 0) || interval >= FSRS7_MODEL_BOUNDS.sMax * 0.999) break;
        state = algorithm.next_state(state, Math.max(1, Math.round(interval)), Rating.Good);
    }
    return points;
}

function ratioAt(points: { interval: number; logRatio: number }[], days: number): number {
    if (days <= points[0].interval) return Math.exp(points[0].logRatio);
    for (let i = 1; i < points.length; i++) {
        if (days <= points[i].interval) {
            const a = points[i - 1], b = points[i];
            const f = (Math.log(days) - Math.log(a.interval)) / (Math.log(b.interval) - Math.log(a.interval));
            return Math.exp(a.logRatio + f * (b.logRatio - a.logRatio));
        }
    }
    return Math.exp(points[points.length - 1].logRatio);
}

/**
 * An FSRS-7 memory state for a card whose history is an FSRS-6 (or SM-2) one:
 * recall falls to 90% on exactly the day it did before (`days`), with the fast
 * trace a typical card of that difficulty would have built by then.
 *
 * FSRS-6 stability IS its 90% day, so this keeps every card's next review where it
 * was. It is a SEED, not a measurement — the upstream advice is to keep such cards
 * on FSRS-6 rather than invent a fast trace — taken for the same reason as the SM-2
 * migration before it: one scheduler for every card, and a reset would put the
 * whole library back into today's queue. The next review corrects it.
 */
function seedMemory(days: number, d: number): FSRS7State {
    const difficulty = clampD(d);
    const ratio = ratioAt(typicalTrajectory(difficulty), days);
    const recallAtDays = (s: number) =>
        algorithm.curve(days, { stability: s, stabilityFast: clampS(s * ratio), difficulty }).retrievability;
    let lo = Math.log(FSRS7_MODEL_BOUNDS.sMin), hi = Math.log(FSRS7_MODEL_BOUNDS.sMax);
    for (let i = 0; i < 80; i++) {
        const mid = (lo + hi) / 2;
        if (recallAtDays(Math.exp(mid)) < REQUEST_RETENTION) lo = mid; else hi = mid;
    }
    const stability = Math.exp(hi);
    return { stability, stabilityFast: clampS(stability * ratio), difficulty };
}

const MS_PER_DAY = 86_400_000;
const finiteOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
// ts-fsrs refuses a card whose reviews, lapses or ladder rung is not a
// non-negative integer ("Expected non-negative integer lapses"), and the rating
// buttons build the card while rendering. A stored count that is not one reads as 0.
const countOf = (v: unknown): number => Math.max(0, Math.round(finiteOrNull(v) ?? 0));

function isReviewed(card: CardSrsState): boolean {
    const last = card.last_reviewed ? new Date(card.last_reviewed) : null;
    return countOf(card.review_count) > 0 || (!!last && !Number.isNaN(last.getTime())) || finiteOrNull(card.stability) != null;
}

/**
 * The FSRS-7 memory state of a stored row, and whether it was SEEDED rather than
 * read (`null` for a card never reviewed):
 *
 *  1. **FSRS-7** (`stability_fast` present) → read from the columns.
 *  2. **FSRS-6** (`stability` without `stability_fast`) → seeded at its 90% day,
 *     which is its stability.
 *  3. **SM-2** (reviewed, no stability) → seeded at its last interval, with the
 *     ease mapped to a difficulty. Never reset: a reset would discard every earned
 *     interval and dump the library into today's queue.
 */
export function memoryStateOf(card: CardSrsState): { memory: FSRS7State; seeded: boolean } | null {
    // A stored value that is not a finite number (text a malformed write left in
    // the column) reads as absent: ts-fsrs refuses a non-finite state outright,
    // and the rating buttons compute their hints while rendering.
    const stability = finiteOrNull(card.stability);
    const stabilityFast = finiteOrNull(card.stability_fast);
    const difficulty = finiteOrNull(card.fsrs_difficulty) ?? 5;
    if (stability != null && stabilityFast != null) {
        return {
            memory: {
                stability: clampS(stability),
                stabilityFast: clampS(stabilityFast),
                difficulty: clampD(difficulty),
            },
            seeded: false,
        };
    }
    if (stability != null) {
        return { memory: seedMemory(Math.max(0.0007, stability), difficulty), seeded: true };
    }
    if (!isReviewed(card)) return null;
    return {
        memory: seedMemory(Math.max(1, finiteOrNull(card.last_interval) ?? 1),
            fsrsDifficultyFromEase(finiteOrNull(card.ease_factor) ?? DEFAULT_EASE)),
        seeded: true,
    };
}

const SCHEDULE_STATUS = ['new', 'learning', 'review', 'learning'] as const;

/**
 * Build the scheduler's card for a stored row: an empty card when it was never
 * reviewed, otherwise its memory state (`memoryStateOf`) and the stored dates.
 *
 * A card with a memory state is never New. Anki imports that keep the schedule
 * store `state` 0 with an earned interval; read as New, Good put a 120-day card on
 * a 10-minute step. Such a card is in Review.
 */
function toSchedulerCard(card: CardSrsState, now: Date): SchedulerCard {
    const found = memoryStateOf(card);
    if (!found) return scheduler.newCard({ now, cardId: 0 });

    const stored = card.state ?? State.Review;
    const state = stored === State.Learning || stored === State.Relearning ? stored : State.Review;
    const dueRead = card.next_review ? new Date(card.next_review) : now;
    const due = Number.isNaN(dueRead.getTime()) ? now : dueRead;
    // With no review stamp, the review that set the due date is the best guess at
    // when it happened: "just now" would read an overdue card as a same-day step.
    const last = card.last_reviewed ? new Date(card.last_reviewed) : null;
    const interval = finiteOrNull(card.last_interval) ?? 0;
    const implied = interval > 0 ? new Date(due.getTime() - interval * MS_PER_DAY) : null;
    const lastReviewAt = [last, implied].find(d => d && !Number.isNaN(d.getTime()) && d.getTime() <= now.getTime()) ?? now;

    return definition.schema.card.parse({
        cardId: 0,
        dueAt: due,
        lastReviewAt,
        stability: found.memory.stability,
        stabilityFast: found.memory.stabilityFast,
        difficulty: found.memory.difficulty,
        state,
        scheduleStatus: SCHEDULE_STATUS[state],
        scheduledDays: Math.max(0, interval),
        learningStep: countOf(card.learning_steps),
        reps: countOf(card.review_count),
        lapses: countOf(card.lapses),
    }) as SchedulerCard;
}

/**
 * One review, applied. A day-scale review lands on a WHOLE number of days after
 * now, the way FSRS-6 scheduled it: the card comes due at the time of day it was
 * reviewed, and `last_interval` stays the integer every reader of it expects. A
 * (re)learning step keeps its exact minutes.
 */
function review(card: CardSrsState, rating: ReviewRating, now: Date) {
    const next = scheduler.review({ card: toSchedulerCard(card, now), grade: RATING_MAP[rating], now }).card;
    const exact = (next.dueAt.getTime() - now.getTime()) / MS_PER_DAY;
    const dayScale = !isInLearning(next.state) && exact >= 1;
    const wholeDays = dayScale ? Math.round(exact) : 0;
    const dueAt = dayScale ? new Date(now.getTime() + wholeDays * MS_PER_DAY) : next.dueAt;
    return { next, dueAt, wholeDays };
}

/**
 * What a given rating would schedule, without applying it — the "next due in N"
 * hint under each rating button.
 *
 * `intervalDays` is fractional (10 minutes = 0.00694); pass it to `formatInterval`.
 * `learning` says the card comes back within the session — a STATE, not an interval
 * threshold, since a Relearning card can be scheduled a day out.
 */
export function computeNextInterval(
    card: CardSrsState,
    rating: ReviewRating,
    now: Date = new Date(),
): { intervalDays: number; dueAt: Date; state: number; learning: boolean; stability: number; difficulty: number } {
    const { next, dueAt } = review(card, rating, now);
    return {
        intervalDays: Math.max(0, (dueAt.getTime() - now.getTime()) / MS_PER_DAY),
        dueAt,
        state: next.state,
        learning: isInLearning(next.state),
        stability: next.stability,
        difficulty: next.difficulty,
    };
}

/** Everything to persist after a card is reviewed. */
export function computeSrsUpdate(
    card: CardSrsState,
    rating: ReviewRating,
    now: Date = new Date(),
): SrsUpdate {
    const { next, dueAt, wholeDays } = review(card, rating, now);
    return {
        rating: RATING_MAP[rating],
        stability: next.stability,
        stability_fast: next.stabilityFast,
        fsrs_difficulty: next.difficulty,
        state: next.state,
        lapses: next.lapses,
        learning_steps: next.learningStep,
        last_interval: wholeDays,
        difficulty: appDifficultyFromFsrs(next.difficulty),
        last_reviewed: now.toISOString(),
        next_review: dueAt.toISOString(),
    };
}

/**
 * When a rating would bring the card back, as a timestamp — or `null` when it
 * leaves the session for a later day.
 *
 * Review surfaces call this rather than comparing intervals: whether a card comes
 * back is the scheduler's `state`.
 */
export function requeueAt(update: SrsUpdate): number | null {
    if (!isInLearning(update.state)) return null;
    const due = Date.parse(update.next_review);
    return Number.isFinite(due) ? due : null;
}

/**
 * Every field a review writes, and so every field an undo must restore (a rating
 * is saved on press, so undo is a RESTORE). Kept beside `computeSrsUpdate` so the
 * two cannot drift.
 *
 * `?? null` matters: the endpoint writes any field that is not `undefined`, so an
 * omitted key would keep the post-review value. `review_count` is listed because
 * the endpoint bumps it when `last_reviewed` is stamped unless given explicitly.
 */
export const SRS_STATE_FIELDS = [
    'difficulty', 'last_reviewed', 'next_review', 'review_count', 'ease_factor',
    'last_interval', 'stability', 'stability_fast', 'fsrs_difficulty', 'state', 'lapses',
    'learning_steps',
] as const;

export function srsSnapshot(card: Record<string, unknown>, reviewedAt?: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    // Every field but the two dates is a number. One stored as anything else is
    // sent back as null: the endpoint refuses it, and an undo it refuses stays
    // on the stack failing every retry.
    for (const k of SRS_STATE_FIELDS) {
        const v = card[k] ?? null;
        out[k] = k === 'last_reviewed' || k === 'next_review' ? v : finiteOrNull(v);
    }
    // Not a column: tells the endpoint to also remove the review from the log,
    // or the optimiser would fit on a withdrawn rating.
    out.undo_review = true;
    // Not a column either: WHICH review this takes back — the `last_reviewed`
    // stamp the rating wrote (`computeSrsUpdate`). The endpoint refuses with a
    // 409 when the card has been rated since (another tab or device), instead
    // of restoring over the newer review.
    if (reviewedAt) out.undo_of = reviewedAt;
    return out;
}

/** A rating whose write failed, kept so a retry can send exactly it again. */
export interface UnsentRating {
    cardId: number;
    rating: ReviewRating;
    update: SrsUpdate;
    snapshot: Record<string, unknown>;
}

/**
 * The write for a rating press: the one that failed on this card with this
 * rating, again, or a new one. A write can fail AFTER the server stored it (the
 * answer lost on the way back); resent unchanged it carries the same
 * `last_reviewed` stamp, which the endpoint recognises as already applied —
 * recomputed, it would carry a new stamp and count as a second review.
 * The snapshot names the review by that stamp, so its undo can never take back
 * a newer rating made elsewhere.
 */
export function retryOrNew(
    unsent: { current: UnsentRating | null },
    card: CardSrsState & { id: number },
    rating: ReviewRating,
): UnsentRating {
    const last = unsent.current;
    if (last && last.cardId === card.id && last.rating === rating) return last;
    const update = computeSrsUpdate(card, rating);
    const snapshot = srsSnapshot(card as unknown as Record<string, unknown>, update.last_reviewed);
    unsent.current = { cardId: card.id, rating, update, snapshot };
    return unsent.current;
}

/**
 * The endpoint's answer to an undo whose card was rated again since (a 409;
 * `request` in api.ts keeps the body on `err.data`, not the status).
 */
export function isStaleUndo(error: unknown): boolean {
    return (error as { data?: { conflict?: string } } | null)?.data?.conflict === 'reviewed_since';
}

/**
 * Short label for an interval, e.g. "1d", "16d", "1.5mo", "2y".
 *
 * Two intervals must stay distinguishable, so days print as days up to 30 (Anki's
 * boundary) and coarser units carry one decimal (trailing `.0` dropped). Not weeks:
 * rounded, 11–17 days all print "2w", where the rating buttons sit closest.
 */
function coarse(value: number, unit: (n: string) => string): string {
    const rounded = Math.round(value * 10) / 10;
    return unit(String(Number.isInteger(rounded) ? rounded : rounded.toFixed(1)));
}

/**
 * The ladder starts at minutes because (re)learning steps are 1, 6 or 10 minutes out.
 *
 * A sub-day interval is written `<10m` (Anki's notation): a ladder step is the
 * LONGEST the card can wait, since learn-ahead (`LEARN_AHEAD_MS` in useReviewQueue)
 * and the feed serve it early. It is the configured step, identical for every card,
 * not a computed wait. Day-scale intervals are real dates nothing serves early, so
 * they keep the bare number.
 *
 * `days` is fractional, from `computeNextInterval`.
 *
 * The units are `t` keys so a Russian reader gets "17 дн." and not "17d"; called
 * without `t` it prints the English shorthand (this module is also run by
 * `srs-gates.mjs` with no i18n behind it, and those assertions are on that text).
 */
export function formatInterval(days: number, t?: TFunction): string {
    const minutes = days * 1440;
    if (minutes < 59.5) {
        const n = String(Math.max(1, Math.round(minutes)));
        return t ? t("<{{n}}m", { n }) : `<${n}m`;
    }
    if (minutes < 1440) {
        const n = String(Math.round(minutes / 60));
        return t ? t("<{{n}}h", { n }) : `<${n}h`;
    }
    if (days < 30) {
        const n = String(Math.round(days));
        return t ? t("{{n}}d", { n }) : `${n}d`;
    }
    if (days < 365) return coarse(days / 30.44, n => (t ? t("{{n}}mo", { n }) : `${n}mo`));
    return coarse(days / 365, n => (t ? t("{{n}}y", { n }) : `${n}y`));
}

/**
 * Is the measured retention good news, bad news, or not yet news?
 *
 * Observed is compared with the TARGET (where FSRS brings a card back): well above
 * means cards arrive sooner than needed, well below means gaps are too long.
 * Observed vs expected is the calibration question, drawn per bin elsewhere.
 *
 * The band is wide (±4 points) because a few dozen reviews cannot resolve finer and
 * a verdict flipping on one card is worse than none; below `MIN_VERDICT_REVIEWS`
 * there is no verdict. Returns a KIND; the translated sentence is the component's.
 */
export type RetentionVerdict = 'thin' | 'ahead' | 'on-track' | 'behind';

/** Below this, the sample says nothing either way. */
export const MIN_VERDICT_REVIEWS = 30;

/** How far from the target counts as a real difference rather than noise. */
export const VERDICT_BAND = 0.04;

export function retentionVerdict(
    observed: number | null | undefined,
    reviews: number,
    target: number = REQUEST_RETENTION,
): RetentionVerdict {
    if (observed == null || !Number.isFinite(observed) || reviews < MIN_VERDICT_REVIEWS) return 'thin';
    if (observed - target >= VERDICT_BAND) return 'ahead';
    if (target - observed >= VERDICT_BAND) return 'behind';
    return 'on-track';
}
