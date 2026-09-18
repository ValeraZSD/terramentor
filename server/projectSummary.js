// server/projectSummary.js — the project row every grid, sidebar and picker
// renders: progress counts, card counts, due reviews, schedule, teaching.
//
// Lifted out of server/index.js so the counts can be gated directly
// (tools/role-gates.mjs) instead of through a running server. Nothing else
// changed with the move.

import db from './database.js';
import { LEAF_NODE } from './today.js';
import { TOPIC_NODE, projectTeaches } from './nodeRole.js';
import { reviewDue } from './decks.js';
import { getScheduleSummary } from './scheduling.js';
import { projectProgressById } from './progress.js';

// Counts come in two flavours and the difference matters:
//
//   node_count / completed_count  — STRUCTURAL leaves. What tools/leaf-invariant.mjs
//                                   pins, and what "how many rows are in this tree"
//                                   means.
//   topic_count / completed_topic_count — units of WORK: leaves that are things to
//                                   know rather than slices of an imported deck's
//                                   card order. Every progress % the learner sees
//                                   is this pair.
//
// Section headers ("00 — Setup & Logistics") are containers nobody ever
// completes; counting them as work pinned every project below its true
// progress forever, which is why both pairs are scoped to leaves at all.
//
// The count subqueries are pre-aggregated per project rather than joined
// row-wise: nodes × flashcards fans out, and COUNT(DISTINCT) over that product
// hides the cost. Grouping first keeps this one pass per table.
export const PROJECT_SUMMARY_SQL = `
    SELECT
        p.*,
        COALESCE(nc.node_count, 0) as node_count,
        COALESCE(nc.completed_count, 0) as completed_count,
        COALESCE(nc.topic_count, 0) as topic_count,
        COALESCE(nc.completed_topic_count, 0) as completed_topic_count,
        COALESCE(fc.due_flashcard_count, 0) as due_flashcard_count,
        COALESCE(cc.card_count, 0) as card_count,
        COALESCE(cc.seen_card_count, 0) as seen_card_count
    FROM projects p
    LEFT JOIN (
        SELECT n.project_id,
               COUNT(*) as node_count,
               SUM(CASE WHEN n.status IN ('completed', 'skipped') THEN 1 ELSE 0 END) as completed_count,
               -- Leaves that are things to KNOW rather than slices of card
               -- order (server/nodeRole.js). This is what decides whether a
               -- project has a plan worth drawing: one measured import has 32,
               -- another none, and both used to answer "deck" to everything.
               SUM(CASE WHEN ${TOPIC_NODE} THEN 1 ELSE 0 END) as topic_count,
               -- …and the same set, closed. Counting closures over ALL leaves
               -- let a hand-ticked "Stage 4" advance a course's progress bar
               -- while never being able to complete it.
               SUM(CASE WHEN ${TOPIC_NODE} AND n.status IN ('completed', 'skipped')
                        THEN 1 ELSE 0 END) as completed_topic_count
        FROM nodes n
        WHERE ${LEAF_NODE}
        GROUP BY n.project_id
    ) nc ON nc.project_id = p.id
    LEFT JOIN (
        -- Reviews OWED. A never-seen card is not a debt (see reviewDue in
        -- server/decks.js): counting it here is what made a freshly generated
        -- project announce that its owner was hundreds of cards behind.
        SELECT n.project_id, COUNT(*) as due_flashcard_count
        FROM flashcards f
        JOIN nodes n ON n.id = f.node_id
        WHERE ${reviewDue('f')}
        GROUP BY n.project_id
    ) fc ON fc.project_id = p.id
    LEFT JOIN (
        -- Cards, and how many have stopped being strangers. Progress for a
        -- project that is NOT taught is this ratio, not completed over topics:
        -- its stages are never marked complete by hand, so the leaf-status
        -- counters that describe a course correctly read 0% forever.
        SELECT n.project_id,
               COUNT(*) as card_count,
               SUM(CASE WHEN f.review_count > 0 AND f.last_reviewed IS NOT NULL THEN 1 ELSE 0 END) as seen_card_count
        FROM flashcards f
        JOIN nodes n ON n.id = f.node_id
        GROUP BY n.project_id
    ) cc ON cc.project_id = p.id
    ORDER BY p.position
`;

/** Load every project with its summary counts + schedule, dashboard-ready. */
export function loadProjectSummaries() {
    const projects = db.prepare(PROJECT_SUMMARY_SQL).all();
    // One pass for the whole grid (server/progress.js), not a query per card.
    const progress = projectProgressById(projects.map(p => p.id));
    for (const project of projects) {
        // How much of it is DONE, counting a card-shaped topic by the cards met
        // on it. `completed_topic_count` above stays a count of topics anybody
        // actually closed: the two answer different questions and the card
        // prints both, but only this one is ever shown as a percentage.
        project.progress_fraction = progress.get(project.id)?.fraction ?? 0;
        project.schedule = (project.start_date && project.deadline)
            ? getScheduleSummary(project.id)
            : { hasSchedule: false };
        // May its topics be taught? Every screen that used to ask "is this a
        // deck" wants this instead: it decides whether a plan is drawn, whether
        // progress is counted in topics or in cards met, and whether the app
        // nudges for a deadline.
        project.teaches = projectTeaches(project.id);
        // The recalibration baseline is a per-leaf snapshot that only
        // server/scheduling.js reads, and it reads it from the row rather than
        // from here. On `p.*` it rode along to every client that asked for the
        // grid: 300 kB of this endpoint's measured 333 kB was this one column,
        // 133 kB of it for a single archived project. Dropped after the query
        // rather than by naming every column, so a column added later still
        // reaches the screens without a second edit here.
        delete project.baseline_schedule;
    }
    return projects;
}
