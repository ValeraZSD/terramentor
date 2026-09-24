// Spaced-repetition scheduling — FSRS-6, via `ts-fsrs`.
//
// The one scheduler behind every review surface (`FlashcardView`,
// `GlobalFlashcardReview`, `FlashcardFeedCard`), which call `computeSrsUpdate`,
// `computeNextInterval` and `formatInterval`.
//
// FSRS models each card's Difficulty, Stability and Retrievability and schedules the
// next review where predicted recall falls to `REQUEST_RETENTION` (0.9). The published
// "20–30% fewer reviews than SM-2" assumes parameters fitted on the learner's own log;
// it is not measured on this app, so do not quote it as ours. The published FSRS-6
// defaults ship until `server/fsrsOptimizer.js` fits a vector that beats them.
//
// Not a hand-rolled copy: `ts-fsrs` is the open-spaced-repetition project's own
// implementation (MIT, no runtime deps), and FSRS keeps changing (17 → 19 → 21
// parameters across versions). It reports `FSRSVersion = "v5.4.1 using FSRS-6.0"`.
//
// Configuration:
// - `enable_short_term: true` — (re)learning steps schedule in MINUTES, so "Again"
//   means "shortly", not "tomorrow". A successful review is unaffected (Hard/Good/Easy
//   on a mature card give identical stability either way); Again on a mature card goes
//   10 minutes into Relearning, and a new card walks 1m → 10m first.
// - `learning_steps` / `relearning_steps` — Anki's `1m, 10m` and `10m` (also ts-fsrs's
//   defaults), named explicitly because `generatorParameters` clamps `w` by
//   `relearning_steps.length`: changing the ladder changes what a fitted vector means.
// - `enable_fuzz: false` — the feed already caps reviews per day, so fuzz's pile-up
//   protection is moot, and determinism lets `tools/srs-gates.mjs` assert scheduling.
//
// Columns:
// - `difficulty`: 0–5, higher = harder, DERIVED from FSRS difficulty (1–10); the
//   dashboard counts `>= 3` as weak.
// - `last_interval`: FSRS `scheduled_days`, still written. `ease_factor` (SM-2) is not
//   written; it is read once to migrate a pre-FSRS card.

import {
    fsrs, generatorParameters, createEmptyCard, Rating, State,
    type Card as FsrsCard, type FSRSParameters,
} from 'ts-fsrs';

export type ReviewRating = 'again' | 'hard' | 'good' | 'easy';

/** Target probability of recall at the moment a card comes up. */
export const REQUEST_RETENTION = 0.9;

/** Legacy SM-2 default, kept only so a pre-FSRS card can be migrated. */
export const DEFAULT_EASE = 2.5;
const MIN_EASE = 1.3;

/** The 21-parameter FSRS-6 vector in use: `null` = the published defaults. */
let activeW: number[] | null = null;

/**
 * The (re)learning ladders, in ts-fsrs's `<number><m|h|d>` notation. Load-bearing:
 * `generatorParameters` clips `w` by `relearning_steps.length`.
 */
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

function buildParams(w: number[] | null): FSRSParameters {
    return generatorParameters({
        request_retention: REQUEST_RETENTION,
        enable_fuzz: false,
        enable_short_term: true,
        learning_steps: [...LEARNING_STEPS],
        relearning_steps: [...RELEARNING_STEPS],
        ...(w ? { w } : {}),
    });
}

let PARAMS: FSRSParameters = buildParams(null);
let scheduler = fsrs(PARAMS);

/**
 * Switch the scheduler to a fitted parameter vector, or back to the defaults.
 *
 * The vector is the `fsrs_params` setting (written by server/fsrsOptimizer.js once
 * it beats the defaults on held-out reviews), applied on every settings load. An
 * invalid vector (wrong length, a NaN) falls back to the defaults: one corrupt
 * weight schedules confidently and wrongly.
 */
export function configureSrs({ w = null }: { w?: number[] | null } = {}): void {
    const valid = Array.isArray(w) && w.length === 21 && w.every(v => typeof v === 'number' && Number.isFinite(v))
        ? [...w] : null;
    if (JSON.stringify(valid) === JSON.stringify(activeW)) return;
    activeW = valid;
    PARAMS = buildParams(valid);
    scheduler = fsrs(PARAMS);
}

const RATING_MAP: Record<ReviewRating, Rating.Again | Rating.Hard | Rating.Good | Rating.Easy> = {
    again: Rating.Again,
    hard: Rating.Hard,
    good: Rating.Good,
    easy: Rating.Easy,
};

/** What a stored flashcard row looks like to the scheduler. */
export interface CardSrsState {
    // FSRS state — null on a card that has never been reviewed under FSRS.
    stability?: number | null;
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
    fsrs_difficulty: number;
    state: number;
    lapses: number;
    learning_steps: number;
    last_interval: number;   // whole days — FSRS `scheduled_days`, 0 on a sub-day
                             // step (read as "learning" by `cardState()` in
                             // server/deckStructure.js, exported by Anki as new).
    difficulty: number;      // app-wide 0-5 convention, derived from FSRS D
    last_reviewed: string;   // ISO timestamp
    next_review: string;     // ISO timestamp
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

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
 * Build the FSRS card for a stored row:
 *
 *  1. **Never reviewed** → an empty FSRS card.
 *  2. **Reviewed under SM-2** → *migrated*, never reset (a reset would discard every
 *     earned interval and dump the library into today's queue). The old interval
 *     seeds stability, which means the same thing; ease seeds difficulty.
 *  3. **Already on FSRS** → reconstructed from the stored columns.
 */
function toFsrsCard(card: CardSrsState, now: Date): FsrsCard {
    const lastReview = card.last_reviewed ? new Date(card.last_reviewed) : null;
    const reviewed = (card.review_count ?? 0) > 0 || !!lastReview;

    if (!reviewed && card.stability == null) return createEmptyCard(now);

    const migrating = card.stability == null;
    const stability = migrating
        ? Math.max(1, card.last_interval ?? 1)
        : Math.max(0.01, card.stability as number);
    const difficulty = migrating
        ? fsrsDifficultyFromEase(card.ease_factor ?? DEFAULT_EASE)
        : clamp(card.fsrs_difficulty ?? 5, 1, 10);

    const validLast = lastReview && !Number.isNaN(lastReview.getTime()) ? lastReview : null;
    const elapsed = validLast
        ? Math.max(0, Math.round((now.getTime() - validLast.getTime()) / 86_400_000))
        : 0;
    const due = card.next_review ? new Date(card.next_review) : now;

    return {
        due: Number.isNaN(due.getTime()) ? now : due,
        stability,
        difficulty,
        // Required by `Card`; the scheduler recomputes it (`AbstractScheduler.init`).
        elapsed_days: elapsed,
        scheduled_days: Math.max(0, card.last_interval ?? 0),
        // A migrating SM-2 card lands in Review, where this is unread.
        learning_steps: Math.max(0, Math.round(card.learning_steps ?? 0)),
        reps: card.review_count ?? 0,
        lapses: card.lapses ?? 0,
        state: (card.state ?? State.Review) as State,
        last_review: validLast ?? undefined,
    };
}

const MS_PER_DAY = 86_400_000;

/**
 * How long a rating actually schedules for, in fractional days: the distance to
 * `due`. Not `scheduled_days`, which is 0 on every (re)learning step.
 */
function intervalDaysOf(dueAt: Date, now: Date): number {
    return Math.max(0, (dueAt.getTime() - now.getTime()) / MS_PER_DAY);
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
    const scheduled = scheduler.repeat(toFsrsCard(card, now), now)[RATING_MAP[rating]].card;
    return {
        intervalDays: intervalDaysOf(scheduled.due, now),
        dueAt: scheduled.due,
        state: scheduled.state,
        learning: isInLearning(scheduled.state),
        stability: scheduled.stability,
        difficulty: scheduled.difficulty,
    };
}

/**
 * Everything to persist after a card is reviewed.
 *
 * `next_review` is FSRS's own `due`, never `now + round(days)`, which loses the
 * minutes and drifts from the state the scheduler will read back.
 */
export function computeSrsUpdate(
    card: CardSrsState,
    rating: ReviewRating,
    now: Date = new Date(),
): SrsUpdate {
    const scheduled = scheduler.repeat(toFsrsCard(card, now), now)[RATING_MAP[rating]].card;

    return {
        rating: RATING_MAP[rating],
        stability: scheduled.stability,
        fsrs_difficulty: scheduled.difficulty,
        state: scheduled.state,
        lapses: scheduled.lapses,
        learning_steps: scheduled.learning_steps,
        last_interval: scheduled.scheduled_days,
        difficulty: appDifficultyFromFsrs(scheduled.difficulty),
        last_reviewed: now.toISOString(),
        next_review: scheduled.due.toISOString(),
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
    'last_interval', 'stability', 'fsrs_difficulty', 'state', 'lapses',
    'learning_steps',
] as const;

export function srsSnapshot(card: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const k of SRS_STATE_FIELDS) out[k] = card[k] ?? null;
    // Not a column: tells the endpoint to also remove the review from the log,
    // or the optimiser would fit on a withdrawn rating.
    out.undo_review = true;
    return out;
}

/**
 * Short label for an interval, e.g. "1d", "16d", "1.5mo", "2y".
 *
 * Two intervals must stay distinguishable, so days print as days up to 30 (Anki's
 * boundary) and coarser units carry one decimal (trailing `.0` dropped). Not weeks:
 * rounded, 11–17 days all print "2w", where the rating buttons sit closest.
 */
function coarse(value: number, unit: string): string {
    const rounded = Math.round(value * 10) / 10;
    return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}${unit}`;
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
 */
export function formatInterval(days: number): string {
    const minutes = days * 1440;
    if (minutes < 59.5) return `<${Math.max(1, Math.round(minutes))}m`;
    if (minutes < 1440) return `<${Math.round(minutes / 60)}h`;
    if (days < 30) return `${Math.round(days)}d`;
    if (days < 365) return coarse(days / 30.44, 'mo');
    return coarse(days / 365, 'y');
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
