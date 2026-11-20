// Which topics are FADING: answered well here once, then left alone long
// enough that a recall question is worth asking. One definition for the two
// lists that show them, `getDecayingNodes` (mastery.js: the feed's recall
// cards, the daily plan's review step) and Today's decaying topics
// (`buildTodayData` in today.js), which were two copies of one query.
// tools/mcp-gates.mjs asserts they agree.
//
// A topic is fading when all of these hold:
//   - it has answers of its own here (`total_attempts > 0`). A seeded prior
//     (placement 0.52, transfer 0.6) clears the bar by itself, and without
//     this a topic never taught came back as a recall question two weeks
//     after the probe: only something learned here can be forgotten here;
//   - the app's own evidence has not touched it since the cutoff
//     (`last_updated`, the decay timer);
//   - it is not skipped and not a piece of Material;
//   - its estimate is over FADING_BAR, read past agents' claims while they
//     alone hold it where it is.
//
// The last clause is for claims (server/claims.js). A claim moves
// `mastery_score` and nothing else, so a topic at 0.85 that one wrong claim
// took to 0.47 used to drop off this list: an agent saying "they got it
// wrong" made the app ask about the topic LESS. And right claims that lift a
// topic at 0.45 to 0.6 would put one never proven here on it. Now, while the
// estimate still sits where the newest claim that moved it left it, the bar
// reads the estimate that claim started from, walked back through each
// earlier claim it was stacked on (a lift, or a lowering after a probe answer,
// which adds evidence and no estimate). Claims alone therefore neither take a
// topic off this list nor put one on it. Once something of the app's own
// moves the estimate (an answer, a rebuild after a reported question), the
// topic follows its real score again; an answer's update starts from the
// estimate the claims left, as every update starts from the current one.

import { studyDay } from './studyDay.js';

/** Over this, a topic left alone is worth a recall question. */
export const FADING_BAR = 0.5;

// "Still sits where the claim left it": the same double claims.js wrote, with
// the tolerance its own spent check uses.
const SAME = 1e-9;

// A claim on this row's topic that moved it: a wrong one that lowered it or a
// right one that lifted it.
const MOVING = 'l.node_id = nm.node_id AND l.mastery_after <> l.mastery_before';

// The estimate before the run of claims that holds `nm.mastery_score` where
// it is, or NULL when no claim does. Correlated on `nm`.
const SCORE_BEFORE_CLAIMS = `(
    WITH RECURSIVE run(id, before) AS (
        SELECT c.id, c.mastery_before FROM mastery_claims c
        WHERE c.id = (SELECT MAX(l.id) FROM mastery_claims l WHERE ${MOVING})
          AND ABS(c.mastery_after - nm.mastery_score) < ${SAME}
        UNION ALL
        SELECT p.id, p.mastery_before FROM run
        JOIN mastery_claims p ON p.id = (SELECT MAX(l.id) FROM mastery_claims l WHERE ${MOVING} AND l.id < run.id)
        WHERE ABS(p.mastery_after - run.before) < ${SAME}
    )
    SELECT before FROM run ORDER BY id LIMIT 1
)`;

/**
 * The fading predicate over `node_mastery nm JOIN nodes n`, with ONE `?`: the
 * cutoff from `fadingCutoff`. The bar reads the estimate the claims holding
 * it found, else the stored one.
 */
export const FADING_TOPIC = `
    nm.total_attempts > 0
    AND nm.last_updated < ?
    AND n.status != 'skipped'
    AND n.is_note = 0
    AND COALESCE(${SCORE_BEFORE_CLAIMS}, nm.mastery_score) > ${FADING_BAR}
`;

/**
 * SLIPPED: a topic answered wrong on a look back or a mock exam (the question
 * log's 'mock' surface) on an earlier day than today, the learner's day, with
 * no right answer on it since. One wrong answer of ten cannot judge a topic, so
 * a slip reopens nothing and takes no proof away: the topic comes back as a
 * recall question the next day the learner studies, as the screens promise
 * (the result screen showed the right answer; a retest a day later does more
 * than one straight after; questionLog.js `recallOrder` asks the missed
 * question itself first) until one of its questions is
 * answered right, and the fading clock spaces it out from there. A right
 * answer counts from a minute after the miss, so the same sitting's other
 * answers never clear it. One `?`: `slipCutoff(now)`.
 */
export const SLIPPED_TOPIC = `(
    n.status != 'skipped' AND n.is_note = 0
    AND EXISTS (
        SELECT 1 FROM question_log m
        WHERE m.node_id = n.id AND m.surface = 'mock' AND m.correct = 0 AND m.asked_at < ?
          AND NOT EXISTS (
              SELECT 1 FROM question_log r
              WHERE r.node_id = n.id AND r.correct = 1
                AND r.asked_at > strftime('%Y-%m-%dT%H:%M:%fZ', m.asked_at, '+1 minute')
          )
    )
)`;

/**
 * What the recall round asks about: fading OR slipped, over `node_mastery nm
 * JOIN nodes n`, with TWO `?`: `recallCutoffs(decayDays, now)`. The plan's
 * list (`getDecayingNodes`) and Today's both read this; the topic panel's
 * "fading" word reads FADING_TOPIC alone, because a slip is not fading.
 */
export const RECALL_TOPIC = `((${FADING_TOPIC}) OR ${SLIPPED_TOPIC})`;

/** When the learner's day holding `now` began, ISO: the question log's own shape. */
export function slipCutoff(now = new Date()) {
    return studyDay({ now: new Date(now).getTime() }).start;
}

/** RECALL_TOPIC's two parameters, in order. */
export function recallCutoffs(decayDays, now = new Date()) {
    return [fadingCutoff(decayDays, now), slipCutoff(now)];
}

/**
 * The decay cutoff, `decayDays` before `now`, in `last_updated`'s own shape.
 * last_updated is written by SQLite's CURRENT_TIMESTAMP ('YYYY-MM-DD HH:MM:SS',
 * UTC); an ISO string ('...T...Z') sorts after every same-day SQLite timestamp
 * and would silently widen the window by a day.
 */
export function fadingCutoff(decayDays, now = new Date()) {
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - decayDays);
    return cutoff.toISOString().slice(0, 19).replace('T', ' ');
}
