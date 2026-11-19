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
db.function('topic_dates_touch', { deterministic: false }, (projectId) => {
    if (projectId == null) allStale = true;
    else stale.add(Number(projectId));
    return null;
});

// Everything `layTopicDates` reads: the tree and each topic's status and
// completion, the window and study week, head starts (node_mastery), and what
// decides whether a project is measured in cards (its cards, `projects.kind`,
// the per-project "teaches" row in settings).
const NODE_COLS = 'status, parent_id, position, is_note, role, estimated_weight, completed_at, project_id';
const OF_NODE = (row) => `(SELECT project_id FROM nodes WHERE id = ${row}.node_id)`;
db.exec(`
    CREATE TEMP TRIGGER IF NOT EXISTS topic_dates_node_ins AFTER INSERT ON nodes
    BEGIN SELECT topic_dates_touch(NEW.project_id); END;
    CREATE TEMP TRIGGER IF NOT EXISTS topic_dates_node_upd AFTER UPDATE OF ${NODE_COLS} ON nodes
    BEGIN SELECT topic_dates_touch(OLD.project_id); SELECT topic_dates_touch(NEW.project_id); END;
    CREATE TEMP TRIGGER IF NOT EXISTS topic_dates_node_del AFTER DELETE ON nodes
    BEGIN SELECT topic_dates_touch(OLD.project_id); END;
    CREATE TEMP TRIGGER IF NOT EXISTS topic_dates_project_ins AFTER INSERT ON projects
    BEGIN SELECT topic_dates_touch(NEW.id); END;
    CREATE TEMP TRIGGER IF NOT EXISTS topic_dates_project_upd AFTER UPDATE OF start_date, deadline, study_days, kind ON projects
    BEGIN SELECT topic_dates_touch(NEW.id); END;
    CREATE TEMP TRIGGER IF NOT EXISTS topic_dates_teach_ins AFTER INSERT ON settings WHEN NEW.key LIKE '${TEACH_PREFIX}%'
    BEGIN SELECT topic_dates_touch(NULL); END;
    CREATE TEMP TRIGGER IF NOT EXISTS topic_dates_teach_upd AFTER UPDATE ON settings WHEN NEW.key LIKE '${TEACH_PREFIX}%'
    BEGIN SELECT topic_dates_touch(NULL); END;
    CREATE TEMP TRIGGER IF NOT EXISTS topic_dates_teach_del AFTER DELETE ON settings WHEN OLD.key LIKE '${TEACH_PREFIX}%'
    BEGIN SELECT topic_dates_touch(NULL); END;
    CREATE TEMP TRIGGER IF NOT EXISTS topic_dates_card_move AFTER UPDATE OF node_id ON flashcards
    BEGIN SELECT topic_dates_touch(${OF_NODE('OLD')}); SELECT topic_dates_touch(${OF_NODE('NEW')}); END;
    CREATE TEMP TRIGGER IF NOT EXISTS topic_dates_project_del AFTER DELETE ON projects
    BEGIN SELECT topic_dates_touch(OLD.id); END;
    CREATE TEMP TRIGGER IF NOT EXISTS topic_dates_mastery_ins AFTER INSERT ON node_mastery
    BEGIN SELECT topic_dates_touch(${OF_NODE('NEW')}); END;
    CREATE TEMP TRIGGER IF NOT EXISTS topic_dates_mastery_upd AFTER UPDATE ON node_mastery
    BEGIN SELECT topic_dates_touch(${OF_NODE('NEW')}); END;
    CREATE TEMP TRIGGER IF NOT EXISTS topic_dates_mastery_del AFTER DELETE ON node_mastery
    BEGIN SELECT topic_dates_touch(${OF_NODE('OLD')}); END;
    CREATE TEMP TRIGGER IF NOT EXISTS topic_dates_card_ins AFTER INSERT ON flashcards
    BEGIN SELECT topic_dates_touch(${OF_NODE('NEW')}); END;
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
    FROM main.nodes n
    LEFT JOIN topic_plan_projects tp ON tp.project_id = n.project_id
    LEFT JOIN topic_dates td ON td.node_id = n.id;
`);

const clearProject = db.prepare('DELETE FROM topic_dates WHERE project_id = ?');
const unplan = db.prepare('DELETE FROM topic_plan_projects WHERE project_id = ?');
const plan = db.prepare('INSERT INTO topic_plan_projects (project_id) VALUES (?)');
const putDate = db.prepare('INSERT INTO topic_dates (node_id, project_id, scheduled_start, scheduled_end) VALUES (?, ?, ?, ?)');
const allProjects = db.prepare('SELECT id FROM projects').pluck();
const knownProjects = db.prepare('SELECT project_id FROM topic_plan_projects').pluck();

let key = null;

/**
 * Bring `plan_nodes` up to date for the learner's day. Call it before a query
 * that reads `plan_nodes`; it does nothing when no input changed.
 */
export function refreshTopicDates({ today = studyToday(), timeZone = learnerTimeZone() } = {}) {
    const k = `${today}|${timeZone}|${db.pragma('data_version', { simple: true })}`;
    if (k !== key) { key = k; allStale = true; }
    if (!allStale && stale.size === 0) return;
    const ids = allStale ? [...new Set([...allProjects.all(), ...knownProjects.all()])] : [...stale];
    const wasAll = allStale;
    allStale = false;
    stale.clear();
    try {
        db.transaction(() => {
            for (const id of ids) {
                clearProject.run(id);
                unplan.run(id);
                const dates = layTopicDates(id, today, timeZone);
                if (!dates) continue;
                plan.run(id);
                for (const [nodeId, d] of dates) putDate.run(nodeId, id, d.start, d.end);
            }
        })();
    } catch (err) {
        // Rolled back: keep the marks, so the next read tries again rather
        // than serving what this one could not replace.
        if (wasAll) allStale = true;
        for (const id of ids) stale.add(id);
        throw err;
    }
}

/** The derived dates of one project's nodes, refreshed first: `Map<id, {start, end}>`. */
export function topicDatesOf(projectId, opts) {
    refreshTopicDates(opts);
    return new Map(db.prepare(`
        SELECT id, scheduled_start AS start, scheduled_end AS "end" FROM plan_nodes
        WHERE project_id = ? AND scheduled_start IS NOT NULL
    `).all(projectId).map(r => [r.id, { start: r.start, end: r.end }]));
}
