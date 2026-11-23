// Topic dates as every reader sees them: derived, never stored.
//
// A course with a window has no topic dates of its own. `layTopicDates`
// (server/scheduling.js) works them out from the record, the window and the
// study week; this module keeps the result for every course in two TEMP tables
// (this connection's memory, never the library file, never synced) and exposes
// them through the TEMP view `plan_nodes`: every column of `nodes`, with
// `scheduled_start`/`scheduled_end` replaced by the derived dates for a course
// that has a window. A project without one keeps whatever its rows carry.
//
// A reader calls `refreshTopicDates()` and then selects FROM plan_nodes instead
// of FROM nodes. The refresh is cheap when nothing changed: TEMP triggers on
// the tables the layout reads mark the touched project stale, and the key
// (the learner's day, their zone, `data_version` for writes by another
// connection) marks all of them stale.

import db from './database.js';
import { layTopicDates } from './scheduling.js';
import { learnerTimeZone, studyToday } from './studyDay.js';
import { TEACH_PREFIX } from './nodeRole.js';

db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS topic_dates (
        node_id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL,
        scheduled_start TEXT,
        scheduled_end TEXT
    );
    CREATE INDEX IF NOT EXISTS temp.topic_dates_project ON topic_dates(project_id);
    CREATE TEMP TABLE IF NOT EXISTS topic_plan_projects (project_id INTEGER PRIMARY KEY);
`);

const stale = new Set();
let allStale = true;
// NULL marks nothing: a card deleted with its topic finds no topic row any
// more, and the topic's own delete has already marked its project.
db.function('topic_dates_touch', { deterministic: false }, (projectId) => {
    if (projectId != null) stale.add(Number(projectId));
    return null;
});
db.function('topic_dates_touch_all', { deterministic: false }, () => {
    allStale = true;
    return null;
});

// Everything `layTopicDates` reads: the tree and each topic's status and
// completion, the window and study week, head starts (node_mastery), and what
// decides whether a project is measured in cards (its cards, `projects.kind`,
// the per-project "teaches" row in settings).
const NODE_COLS = 'status, parent_id, position, is_note, role, estimated_weight, completed_at, project_id, deleted_at';
const OF_NODE = (row) => `(SELECT project_id FROM live_nodes nodes WHERE id = ${row}.node_id)`;
// A card deleted or restored with its topic: the topic is marked in the same
// statement, so its project is read past the deleted filter.
const OF_ANY_NODE = (row) => `(SELECT project_id FROM nodes /* with deleted */ WHERE id = ${row}.node_id)`;
// A closed topic with no completion time sits on its row's end date, else on
// the day the row last changed (`layTopicDates`).
const CLOSED_UNDATED = "NEW.status IN ('completed', 'skipped') AND NEW.completed_at IS NULL";
// An answer changes `mastery_score`/`total_attempts` on every topic; they move
// the plan only through a head start (`headStartOf`), so only a row that has or
// had a seed marks its project.
const SEED_MOVED = `(COALESCE(OLD.transferred_prior, OLD.placement_prior, NEW.transferred_prior, NEW.placement_prior) IS NOT NULL)
    AND (OLD.transferred_prior IS NOT NEW.transferred_prior OR OLD.placement_prior IS NOT NEW.placement_prior
      OR OLD.mastery_score IS NOT NEW.mastery_score OR OLD.total_attempts IS NOT NEW.total_attempts)`;
db.exec(`
    CREATE TEMP TRIGGER IF NOT EXISTS topic_dates_node_ins AFTER INSERT ON nodes
    BEGIN SELECT topic_dates_touch(NEW.project_id); END;
    CREATE TEMP TRIGGER IF NOT EXISTS topic_dates_node_upd AFTER UPDATE OF ${NODE_COLS} ON nodes
    BEGIN SELECT topic_dates_touch(OLD.project_id); SELECT topic_dates_touch(NEW.project_id); END;
    CREATE TEMP TRIGGER IF NOT EXISTS topic_dates_node_closed AFTER UPDATE OF scheduled_end, updated_at ON nodes
    WHEN ${CLOSED_UNDATED}
    BEGIN SELECT topic_dates_touch(NEW.project_id); END;
    CREATE TEMP TRIGGER IF NOT EXISTS topic_dates_node_del AFTER DELETE ON nodes
    BEGIN SELECT topic_dates_touch(OLD.project_id); END;
    CREATE TEMP TRIGGER IF NOT EXISTS topic_dates_project_ins AFTER INSERT ON projects
    BEGIN SELECT topic_dates_touch(NEW.id); END;
    CREATE TEMP TRIGGER IF NOT EXISTS topic_dates_project_upd AFTER UPDATE OF start_date, deadline, study_days, kind ON projects
    BEGIN SELECT topic_dates_touch(NEW.id); END;
    CREATE TEMP TRIGGER IF NOT EXISTS topic_dates_teach_ins AFTER INSERT ON settings WHEN NEW.key LIKE '${TEACH_PREFIX}%'
    BEGIN SELECT topic_dates_touch_all(); END;
    CREATE TEMP TRIGGER IF NOT EXISTS topic_dates_teach_upd AFTER UPDATE ON settings
    WHEN (NEW.key LIKE '${TEACH_PREFIX}%' OR OLD.key LIKE '${TEACH_PREFIX}%') AND (OLD.value IS NOT NEW.value OR OLD.key IS NOT NEW.key)
    BEGIN SELECT topic_dates_touch_all(); END;
    CREATE TEMP TRIGGER IF NOT EXISTS topic_dates_teach_del AFTER DELETE ON settings WHEN OLD.key LIKE '${TEACH_PREFIX}%'
    BEGIN SELECT topic_dates_touch_all(); END;
    CREATE TEMP TRIGGER IF NOT EXISTS topic_dates_card_move AFTER UPDATE OF node_id ON flashcards
    BEGIN SELECT topic_dates_touch(${OF_NODE('OLD')}); SELECT topic_dates_touch(${OF_NODE('NEW')}); END;
    CREATE TEMP TRIGGER IF NOT EXISTS topic_dates_project_del AFTER DELETE ON projects
    BEGIN SELECT topic_dates_touch(OLD.id); END;
    CREATE TEMP TRIGGER IF NOT EXISTS topic_dates_mastery_ins AFTER INSERT ON node_mastery
    BEGIN SELECT topic_dates_touch(${OF_NODE('NEW')}); END;
    CREATE TEMP TRIGGER IF NOT EXISTS topic_dates_mastery_upd AFTER UPDATE ON node_mastery
    WHEN ${SEED_MOVED}
    BEGIN SELECT topic_dates_touch(${OF_NODE('NEW')}); END;
    CREATE TEMP TRIGGER IF NOT EXISTS topic_dates_mastery_del AFTER DELETE ON node_mastery
    BEGIN SELECT topic_dates_touch(${OF_NODE('OLD')}); END;
    CREATE TEMP TRIGGER IF NOT EXISTS topic_dates_card_ins AFTER INSERT ON flashcards
    BEGIN SELECT topic_dates_touch(${OF_NODE('NEW')}); END;
    CREATE TEMP TRIGGER IF NOT EXISTS topic_dates_card_gone AFTER UPDATE OF deleted_at ON flashcards
    BEGIN SELECT topic_dates_touch(${OF_ANY_NODE('NEW')}); END;
    CREATE TEMP TRIGGER IF NOT EXISTS topic_dates_card_del AFTER DELETE ON flashcards
    BEGIN SELECT topic_dates_touch(${OF_NODE('OLD')}); END;
`);

// The view lists `nodes`' own columns, read once the schema is migrated, so a
// column added later reaches every reader without editing this file.
const nodeColumns = db.prepare('PRAGMA main.table_info(nodes)').all().map(c => c.name);
const viewColumns = nodeColumns.map(c => {
    if (c !== 'scheduled_start' && c !== 'scheduled_end') return `n.${c}`;
    return `CASE WHEN tp.project_id IS NULL THEN n.${c} ELSE td.${c} END AS ${c}`;
});
db.exec(`
    DROP VIEW IF EXISTS temp.plan_nodes;
    CREATE TEMP VIEW plan_nodes AS
    SELECT ${viewColumns.join(', ')}
    FROM main.live_nodes n
    LEFT JOIN topic_plan_projects tp ON tp.project_id = n.project_id
    LEFT JOIN topic_dates td ON td.node_id = n.id;
`);

const clearProject = db.prepare('DELETE FROM topic_dates WHERE project_id = ?');
const unplan = db.prepare('DELETE FROM topic_plan_projects WHERE project_id = ?');
const plan = db.prepare('INSERT INTO topic_plan_projects (project_id) VALUES (?)');
const putDate = db.prepare('INSERT INTO topic_dates (node_id, project_id, scheduled_start, scheduled_end) VALUES (?, ?, ?, ?)');
const allProjects = db.prepare('SELECT id FROM live_projects projects').pluck();
const knownProjects = db.prepare('SELECT project_id FROM topic_plan_projects').pluck();

let key = null;
// Projects laid inside a caller's transaction: if it rolls back, so do their
// rows in the TEMP tables, while the marks above say they are current. They
// are laid again by the first refresh outside a transaction.
const laidInTransaction = new Set();
// Projects whose layout threw, reported once each.
const reported = new Set();

const layOne = db.transaction((id, today, timeZone, lay) => {
    clearProject.run(id);
    unplan.run(id);
    const dates = lay(id, today, timeZone);
    if (!dates) return;
    plan.run(id);
    for (const [nodeId, d] of dates) putDate.run(nodeId, id, d.start, d.end);
});

/**
 * Bring `plan_nodes` up to date for the learner's day. Call it before a query
 * that reads `plan_nodes`; it does nothing when no input changed.
 *
 * Each project is laid on its own: one whose layout throws is left unplanned,
 * so its rows read as stored, and every other project is still served. It is
 * tried again once one of its inputs changes. `lay` is for the gates.
 */
export function refreshTopicDates({ today = studyToday(), timeZone = learnerTimeZone(), lay = layTopicDates } = {}) {
    const k = `${today}|${timeZone}|${db.pragma('data_version', { simple: true })}`;
    if (k !== key) { key = k; allStale = true; }
    const inTransaction = db.inTransaction;
    if (!inTransaction && laidInTransaction.size) {
        for (const id of laidInTransaction) stale.add(id);
        laidInTransaction.clear();
    }
    if (!allStale && stale.size === 0) return;
    const ids = allStale ? [...new Set([...allProjects.all(), ...knownProjects.all()])] : [...stale];
    allStale = false;
    stale.clear();
    for (const id of ids) {
        try {
            layOne(id, today, timeZone, lay);
            reported.delete(id);
        } catch (err) {
            // Rolled back to before this project: drop what it had, so its
            // rows read as stored rather than as an older layout.
            clearProject.run(id);
            unplan.run(id);
            if (!reported.has(id)) {
                reported.add(id);
                console.error(`[topicDates] project ${id} could not be laid out; its stored dates are shown:`, err?.message ?? err);
            }
        }
        if (inTransaction) laidInTransaction.add(id);
    }
}

let datesOfStmt = null;

/** The derived dates of one project's nodes, refreshed first: `Map<id, {start, end}>`. */
export function topicDatesOf(projectId, opts) {
    refreshTopicDates(opts);
    datesOfStmt ??= db.prepare(`
        SELECT id, scheduled_start AS start, scheduled_end AS "end" FROM plan_nodes
        WHERE project_id = ? AND scheduled_start IS NOT NULL
    `);
    return new Map(datesOfStmt.all(projectId).map(r => [r.id, { start: r.start, end: r.end }]));
}
