// Spaced-repetition scheduling — FSRS-6, via `ts-fsrs`.
//
// Single source of truth for flashcard review scheduling, shared by every review
// surface (`FlashcardView`, `GlobalFlashcardReview`, `FlashcardFeedCard`). Those
// three call exactly three functions — `computeSrsUpdate`, `computeNextInterval`
// and `formatInterval` — and none of them changed shape when the algorithm did.
//
// ## Why this is not SM-2 any more
//
// SM-2 (1987) schedules by multiplying the last interval by a per-card "ease"
// that drifts up and down by fixed steps. It has no model of memory: it cannot
// say how likely you are to recall a card *today*, so it cannot aim at a
// retention target, and it treats a card reviewed three months late exactly like
// one reviewed on time.
//
// FSRS models each card with three quantities — Difficulty, Stability and
// Retrievability — fitted to large review datasets, and schedules the next review
// at the point where predicted recall drops to a chosen target (`REQUEST_RETENTION`,
// 0.9 here). Published comparisons put it at roughly 20–30% fewer reviews than
// SM-2 for the same retention.
//
// **That figure assumes parameters optimised on the learner's own review log,
// which this app does not do yet.** We ship the published FSRS-6 defaults, which
// are fitted on a large public dataset and are strictly better than SM-2's fixed
// arithmetic, but the headline number is not ours to claim until an optimiser
// exists. Said plainly here so nobody quotes it from this file as if it were
// measured on this app.
//
// ## Why the algorithm is a dependency and not our code
//
// `ts-fsrs` is the open-spaced-repetition project's own TypeScript
// implementation (MIT, zero runtime dependencies). FSRS is a moving target — v4
// → v4.5 → v5 → v6 changed the parameter count from 17 to 19 to 21 and made the
// decay term trainable — and a hand-rolled copy would be a snapshot that silently
// rots. Owning a re-implementation of somebody else's fitted model buys nothing
// this project needs; the moat is elsewhere. The library reports
// `FSRSVersion = "v5.4.1 using FSRS-6.0"` and its `default_w` matches the
// published 21-parameter vector exactly.
//
// ## Configuration, and why each switch is set the way it is
//
// - `enable_short_term: true` — FSRS's (re)learning steps schedule in *minutes*,
//   which is what makes "Again" mean "ask me again shortly" instead of "tomorrow".
//   It was off until 2026-09-03, on the reasoning that `next_review` was a date
//   and the queue was day-grained. Both halves of that turned out to be fixable
//   and neither was really true: `next_review` has always held a full ISO
//   timestamp, and the day-graining lived in a `Math.max(1, scheduled_days)`
//   floor here plus a review session that never returned to a card it had rated.
//   Turning it on changes NOTHING about a successful review — measured on the
//   real library, Hard/Good/Easy on a mature card produce byte-identical
//   stability and the same 12/16/27-day intervals with the switch either way.
//   What changes is the failure path: Again on a mature card now schedules 10
//   minutes in Relearning instead of 1 day in Review, and a new card walks the
//   1m → 10m learning steps before it earns its first day-scale interval.
// - `learning_steps` / `relearning_steps` — ts-fsrs's own defaults, which are
//   Anki's (`1m, 10m` and `10m`). Named explicitly rather than left to default
//   because the parameter clamp in `generatorParameters` is a function of
//   `relearning_steps.length`: the step list is part of the scheduler's
//   configuration, not a display preference, and a silent change to it changes
//   what the optimiser's fitted vector means.
// - `enable_fuzz: false` — fuzz randomises intervals ±5% so large collections
//   don't pile every card onto one day. The feed already caps reviews per day, so
//   the pile-up fuzz protects against cannot happen here, and determinism is worth
//   more: it is what lets `tools/srs-gates.mjs` assert scheduling behaviour at all.
//
// ## Conventions preserved across the app
//
//   - `difficulty`: 0–5, higher = harder; the dashboard counts `>= 3` as weak.
//     Now **derived** from FSRS's own difficulty (1–10) rather than being a
//     hand-rolled counter that incremented on "again" — one source of truth, and
//     a real estimate instead of a tally.
//   - `ease_factor` / `last_interval`: SM-2 columns. `last_interval` still holds
//     the scheduled interval in days (FSRS's `scheduled_days`) and is still
//     written. `ease_factor` has no FSRS equivalent and is **no longer written**;
//     it is read once, to migrate a card that predates this change.

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
 * The (re)learning ladders, in ts-fsrs's `<number><m|h|d>` notation.
 *
 * These are the library's defaults and Anki's, restated here because they are
 * load-bearing rather than cosmetic: `generatorParameters` clips the parameter
 * vector against bounds that depend on `relearning_steps.length`, so changing
 * the ladder changes how a fitted `w` is interpreted.
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
 * True while a card is walking a (re)learning ladder — i.e. it is coming back
 * within the session rather than on a future day. The two states are separate
 * in FSRS because one is a card being met and the other a card being repaired,
 * but every consumer here asks the same question of them.
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
 * The parameters come from the server (`fsrs_params` setting, written by the
 * optimiser in server/fsrsOptimizer.js once it has beaten the defaults on this
 * learner's own held-out reviews) and are applied on every settings load. An
 * invalid vector — wrong length, a NaN — falls back to the defaults rather
 * than to a half-applied one; a scheduler with one corrupt weight schedules
 * confidently and wrongly, which is worse than the population average.
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
    /** Which rung of the (re)learning ladder the card is on. Persisted, because
     *  FSRS's next step is a function of it: a card on step 1 of `1m, 10m` that
     *  is rated Good graduates, one on step 0 moves to 10m. Dropping it (this
     *  used to hardcode 0) restarts the ladder on every reload. */
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
    /** The rating itself, 1-4. Not a card column: the update endpoint appends
     *  it to the review log (server/reviewLog.js), which is what the optimiser
     *  fits on and what retention is measured from. */
    rating: number;
    stability: number;
    fsrs_difficulty: number;
    state: number;
    lapses: number;
    learning_steps: number;
    last_interval: number;   // whole days — FSRS `scheduled_days`, 0 on a
                             // sub-day (re)learning step. `cardState()` in
                             // server/deckStructure.js already reads 0 as
                             // "learning", and the Anki exporter already sends
                             // an ivl-0 card out as new, so nothing downstream
                             // needed teaching about the value.
    difficulty: number;      // app-wide 0-5 convention, derived from FSRS D
    last_reviewed: string;   // ISO timestamp
    next_review: string;     // ISO timestamp
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * FSRS difficulty (1–10) → the app's 0–5 "higher = harder" scale.
 *
 * The dashboard's weak-card metric (`difficulty >= 3`) is defined against this
 * scale, so the mapping is linear across the full FSRS range rather than tuned:
 * a card FSRS puts in the hardest 40% reads as weak, which is what the old
 * counter approximated by incrementing on every lapse.
 */
export function appDifficultyFromFsrs(d: number): number {
    return clamp(Math.round(((d - 1) / 9) * 5), 0, 5);
}

/**
 * SM-2 ease (1.3 … ~2.5+) → an FSRS difficulty estimate (1–10).
 *
 * Used once per card, when a collection built under SM-2 meets FSRS for the
 * first time. Anchored so the SM-2 default ease of 2.5 lands mid-scale and the
 * 1.3 floor lands at maximum difficulty; a card that earned an ease above 2.5
 * maps below the middle.
 */
function fsrsDifficultyFromEase(ease: number): number {
    const e = Math.max(MIN_EASE, ease);
    return clamp(10 - ((e - MIN_EASE) / (DEFAULT_EASE - MIN_EASE)) * 5, 1, 10);
}

/**
 * Build the FSRS card for a stored row.
 *
 * Three cases, and the middle one is the whole reason this function is not two
 * lines:
 *
 *  1. **Never reviewed** → an empty FSRS card.
 *  2. **Reviewed under SM-2, before this change** → *migrated*, not reset.
 *     Treating an existing collection as new would throw away every interval the
 *     learner earned and dump the whole library back into today's queue — the
 *     single worst thing an SRS upgrade can do. The old interval already was an
 *     estimate of "how long until this is about to be forgotten", which is what
 *     stability means, so it seeds stability directly; ease seeds difficulty.
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
        // Ignored by the scheduler, which recomputes it from `last_review`
        // and the review time (`AbstractScheduler.init`). Kept because the
        // `Card` shape requires it.
        elapsed_days: elapsed,
        scheduled_days: Math.max(0, card.last_interval ?? 0),
        // A migrating SM-2 card has no ladder position and lands mid-Review,
        // where the value is unread; an FSRS card carries its own.
        learning_steps: Math.max(0, Math.round(card.learning_steps ?? 0)),
        reps: card.review_count ?? 0,
        lapses: card.lapses ?? 0,
        state: (card.state ?? State.Review) as State,
        last_review: validLast ?? undefined,
    };
}

const MS_PER_DAY = 86_400_000;

/**
 * How long a rating actually schedules for, in (fractional) days.
 *
 * **`scheduled_days` is the wrong field to read and reading it was the bug.**
 * On a (re)learning step FSRS reports `scheduled_days: 0` and puts the real
 * answer in `due` — so the old `Math.max(1, scheduled_days)` did not merely
 * round a 10-minute step, it invented a day that the scheduler had not asked
 * for, and did it identically for every sub-day step. The interval is the
 * distance to `due`, and days are what the rest of this module speaks.
 */
function intervalDaysOf(dueAt: Date, now: Date): number {
    return Math.max(0, (dueAt.getTime() - now.getTime()) / MS_PER_DAY);
}

/**
 * What a given rating would schedule, without applying it — the "next due in N"
 * hint under each rating button.
 *
 * `intervalDays` is fractional now (a 10-minute step is 0.00694 days); pass it
 * to `formatInterval`, which reads the whole range from minutes to years.
 * `learning` says the card would come back inside this session rather than on
 * a later day, which is what the review queue needs to know and what no
 * interval threshold can safely stand in for — a ladder rung is a *state*, and
 * a card can legitimately be scheduled a day out while still in Relearning.
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
 * `next_review` is FSRS's own `due`, not `now + round(days)`. Recomputing it
 * from a rounded day count is what threw the minutes away, and it also drifted
 * on ordinary reviews — the scheduler's `due` is what its own state machine
 * will be read back against.
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
 * The review surfaces call this instead of comparing intervals themselves: the
 * question "does this card come back today" has exactly one right answer and it
 * is the scheduler's `state`, not a threshold on the interval.
 */
export function requeueAt(update: SrsUpdate): number | null {
    if (!isInLearning(update.state)) return null;
    const due = Date.parse(update.next_review);
    return Number.isFinite(due) ? due : null;
}

/**
 * Every field a review writes, and therefore every field taking one back has to
 * put back.
 *
 * A rating reaches the server the instant it is pressed, so undo is a RESTORE,
 * not a UI state change — and the thing being restored is exactly this list.
 * It lives here, beside `computeSrsUpdate`, because these two must not drift:
 * a field that the scheduler learns to write and this forgets to snapshot is an
 * undo that silently only half-works.
 *
 * `?? null` matters. A never-reviewed card holds NULLs, and the update endpoint
 * writes any field that is not `undefined` — so an omitted key would leave the
 * POST-review value in place. Sending explicit nulls is what returns a new card
 * to genuinely new. `review_count` is in the list because the endpoint bumps it
 * whenever `last_reviewed` is stamped, and an explicit value overrides that.
 */
export const SRS_STATE_FIELDS = [
    'difficulty', 'last_reviewed', 'next_review', 'review_count', 'ease_factor',
    'last_interval', 'stability', 'fsrs_difficulty', 'state', 'lapses',
    'learning_steps',
] as const;

export function srsSnapshot(card: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const k of SRS_STATE_FIELDS) out[k] = card[k] ?? null;
    // Restoring the row is half of an undo; the other half is taking the
    // review back out of the log, or a rating the learner withdrew would be
    // fitted on as if it stood. The endpoint reads this flag and does exactly
    // that — it is not a column and is never written to the card.
    out.undo_review = true;
    return out;
}

/**
 * Short human-readable label for an interval, e.g. "1d", "16d", "1.5mo", "2y".
 *
 * **The label has to keep two different intervals looking different**, and the
 * first version did not. It switched to whole weeks at 7 days and rounded, so a
 * real card offering Hard = 12 days and Good = 16 days printed "2w" under both
 * buttons — the one number a rating button exists to show, collapsed by its own
 * formatting. Every value from 11 to 17 days read as "2w": a seven-day-wide bucket
 * on the part of the range where the four ratings sit closest together.
 *
 * So days are printed as days all the way to 30 (Anki's own boundary, and the
 * comparison the learner is actually making), and the coarser units carry one
 * decimal — a trailing `.0` is dropped, because "2mo" is not ambiguous the way
 * a rounded "2w" was. Weeks are gone as a unit: "2.3w" is harder to read than
 * "16d" and says no more.
 */
function coarse(value: number, unit: string): string {
    const rounded = Math.round(value * 10) / 10;
    return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}${unit}`;
}

/**
 * The unit ladder runs from minutes, because the intervals do: a rating that
 * schedules a (re)learning step is 1, 6 or 10 minutes out, and every one of
 * those printed as "1d" while the queue handed the card straight back.
 *
 * **A sub-day interval is written `<10m`, not `10m`, which is Anki's notation
 * and its reason.** The `<` is not decoration and it is not hedging: a ladder
 * step is the LONGEST the card can wait, never the wait itself. The learn-ahead
 * limit serves it as soon as nothing else is left (`LEARN_AHEAD_MS` in
 * useReviewQueue), and in the feed it comes back when the reader scrolls to it —
 * so in ordinary use a "10m" card is answered again well inside ten minutes.
 * Writing the bare number invites exactly the reading it got here: that Again is
 * a *computed* ten minutes the way Hard is a computed five days. It is not.
 * Again's delay is the configured step and is identical for every card in the
 * library; what FSRS computes on a lapse is the stability, and that shows up in
 * the interval the card earns AFTER it graduates off the ladder.
 *
 * Day-scale intervals keep the bare number, because those are real dates the
 * scheduler picked and nothing serves them early.
 *
 * `days` is fractional — it comes from `computeNextInterval`, which measures
 * the distance to FSRS's `due` rather than reading `scheduled_days`.
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
 * The retention panel used to print three percentages side by side and leave
 * the reader to work out what they meant: "99% recalled over 83 reviews ·
 * scheduler expected 85%, target 90%" is a calibration check written for
 * whoever built the scheduler. A learner's question is simpler and never gets
 * answered by a number on its own — *is that good?*
 *
 * The comparison that answers it is observed against the TARGET, not against
 * the scheduler's expectation. `REQUEST_RETENTION` is the point at which FSRS
 * brings a card back, so recalling well above it means the cards are arriving
 * sooner than they need to, and well below it means the gaps are too long.
 * (Observed against `expected` is the calibration question, and that one is
 * already drawn per bin as a bar and a notch.)
 *
 * `band` is deliberately wide: 4 points either side of the target, because a
 * few dozen reviews cannot resolve anything finer, and a verdict that flips
 * between "too often" and "too rarely" on one card is worse than no verdict.
 * Below `MIN_VERDICT_REVIEWS` there is no verdict at all — the honest answer
 * to "is that good?" on 12 reviews is that nobody can tell yet.
 *
 * Returns a KIND rather than a sentence: the sentences are translated, so they
 * belong to the component, not here.
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
