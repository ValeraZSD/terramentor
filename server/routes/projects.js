// /api/projects: the list, one project, create, edit and delete.
//
// Mounted in 3 blocks (see createApp in server/app.js), because the server
// registers other areas' routes between them and Express matches in registration
// order. A new route goes in the block it belongs with.
import db from '../database.js';
import { daysBetween, isScheduleDate, MAX_SCHEDULE_DAYS, readStudyDays } from '../scheduling.js';
import { invalidateProjectLanguage, isSupportedLanguage } from '../language.js';
import { logActivity } from '../activityLog.js';
import { sweepOrphanMedia } from '../ankiImport.js';
import { loadProjectSummaries } from '../projectSummary.js';
import { documentChunkIds, freeDocumentAssets } from '../documentAssets.js';
import { nextProjectPosition } from './projectRows.js';
import { routeTable } from './routeTable.js';

const app = routeTable('projects');

// PROJECTS

app.get('/api/projects', (req, res) => {
    try {
        res.json(loadProjectSummaries());
    } catch (err) {
        console.error('[Projects] DB error:', err.message);
        res.status(500).json({ error: 'Failed to load projects', detail: err.message });
    }
});

app.get('/api/ai/generation-status', (req, res) => {
    const generating = db.prepare('SELECT id, name, ai_generating FROM projects WHERE ai_generating = 1').all();
    res.json({ generating });
});

export const listRoutes = app.takeRoutes();

app.put('/api/projects/reorder', (req, res) => {
    const { projectIds } = req.body;
    const transaction = db.transaction(() => {
        projectIds.forEach((id, index) => {
            db.prepare('UPDATE projects SET position = ? WHERE id = ?').run(index, id);
        });
    });
    transaction();
    // Same shape as GET /api/projects — a degraded row set here would corrupt
    // the grid if a client ever replaces its state with this response. Sharing
    // the query is what keeps that true.
    res.json(loadProjectSummaries());
});

app.get('/api/projects/:id', (req, res) => {
    // `baseline_schedule` is deliberately absent: server/scheduling.js reads the
    // snapshot from the row itself, no client has ever read it, and selecting it
    // here made one archived project's detail 133 kB of a 134 kB reply.
    const project = db.prepare(`
        SELECT id, name, description, summary, color, icon, position, ai_generating,
               start_date, deadline, study_days, status,
               created_at, updated_at
        FROM projects WHERE id = ?
    `).get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json(project);
});

app.post('/api/projects', (req, res) => {
    const { name, description, color, icon, content_language } = req.body;
    const lang = isSupportedLanguage(content_language) ? (content_language || '') : '';
    const result = db.prepare('INSERT INTO projects (name, description, color, icon, position, content_language) VALUES (?, ?, ?, ?, ?, ?)')
        .run(name, description || '', color || '#3B82F6', icon || 'folder', nextProjectPosition(), lang);
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(result.lastInsertRowid);
    // The id, not the name: the name is the learner's, and the id is what every
    // later row in this log will refer to.
    logActivity({ area: 'project', event: 'project.created', projectId: project.id });
    res.json(project);
});

app.put('/api/projects/:id', (req, res) => {
    const { name, description, color, icon, position, start_date, deadline, study_days, status, content_language } = req.body;
    const updates = [];
    const values = [];

    if (name !== undefined) { updates.push('name = ?'); values.push(name); }
    if (description !== undefined) { updates.push('description = ?'); values.push(description); }
    if (color !== undefined) { updates.push('color = ?'); values.push(color); }
    if (icon !== undefined) { updates.push('icon = ?'); values.push(icon); }
    if (position !== undefined) { updates.push('position = ?'); values.push(position); }
    if (status !== undefined && ['active', 'completed', 'archived'].includes(status)) {
        updates.push('status = ?'); values.push(status);
    }
    // The window is checked as the pair it will BE after this write: every
    // schedule reader walks it a day at a time, so an unchecked deadline in the
    // year 99999 blocked the server for half a minute on the next read.
    // Order is not judged here — two edits in a row may pass through an
    // out-of-order pair, and scheduling refuses one — but the SPAN is.
    if (start_date !== undefined || deadline !== undefined) {
        const isSet = v => v !== undefined && v !== null && v !== '';
        for (const [label, v] of [['start_date', start_date], ['deadline', deadline]]) {
            if (isSet(v) && !isScheduleDate(v)) {
                return res.status(400).json({ error: `${label} must be a date written YYYY-MM-DD` });
            }
        }
        const current = db.prepare('SELECT start_date, deadline FROM projects WHERE id = ?').get(req.params.id) || {};
        const nextStart = start_date !== undefined ? start_date : current.start_date;
        const nextDeadline = deadline !== undefined ? deadline : current.deadline;
        if (isScheduleDate(nextStart) && isScheduleDate(nextDeadline)
            && Math.abs(daysBetween(nextStart, nextDeadline)) > MAX_SCHEDULE_DAYS) {
            return res.status(400).json({ error: 'A schedule can span at most 20 years.' });
        }
    }
    if (start_date !== undefined) { updates.push('start_date = ?'); values.push(start_date); }
    if (deadline !== undefined) { updates.push('deadline = ?'); values.push(deadline); }
    // Normalised on the way IN, not just on the way out. This column used to
    // take a client string verbatim, so one hand-crafted request persisted
    // anything at all and every reader downstream had to survive it — which the
    // one in `scheduling.js` did not, making recalibrate throw for that project
    // for ever after. `readStudyDays` is the same reader the app uses, so what
    // is stored is what will be read back.
    if (study_days !== undefined) {
        updates.push('study_days = ?');
        values.push(JSON.stringify(readStudyDays(typeof study_days === 'string' ? study_days : JSON.stringify(study_days))));
    }
    // '' is a valid value ("follow the material"), so the guard is membership in
    // the catalog, not truthiness. An unknown code is ignored rather than stored:
    // a bogus one would be handed to every authoring prompt as an instruction.
    if (content_language !== undefined && isSupportedLanguage(content_language)) {
        updates.push('content_language = ?'); values.push(content_language || '');
    }

    if (updates.length === 0) {
        const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
        return res.json(project);
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(req.params.id);
    db.prepare(`UPDATE projects SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    // The language is cached per project for the life of the process, and it
    // steers every authoring prompt — a stale entry would keep writing lessons
    // in the old language after the learner switched.
    invalidateProjectLanguage(Number(req.params.id));
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    res.json(project);
});

export const editRoutes = app.takeRoutes();

app.delete('/api/projects/:id', (req, res) => {
    // documents/document_chunks cascade via FK on this delete, but vec_chunks
    // and vault blobs don't — capture what's about to be removed first.
    const docs = db.prepare(
        'SELECT id, file_hash FROM documents WHERE project_id = ? OR node_id IN (SELECT id FROM nodes WHERE project_id = ?)'
    ).all(req.params.id, req.params.id);
    const chunkIds = documentChunkIds(docs);

    // Card media: `media_files` cascades with the project, but the bytes are in
    // the blob store, which no FK reaches. The sweep is the same set difference
    // the vault does by hand above — deleting an imported deck must give the
    // disk back, or "undo the import" is only true of the database.
    const hadMedia = db.prepare('SELECT 1 FROM media_files WHERE project_id = ? LIMIT 1').get(req.params.id);

    const projectId = Number(req.params.id);
    db.transaction(() => {
        db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
        // Two per-project dials live in `settings`, keyed by the id, where no
        // foreign key reaches them.
        db.prepare('DELETE FROM settings WHERE key IN (?, ?)').run(`deck_new_per_day_${projectId}`, `teach_topics_${projectId}`);
    })();

    freeDocumentAssets(docs, chunkIds);
    if (hadMedia) sweepOrphanMedia({ allowEmpty: true });
    // Worth a line precisely because the row it points at is gone: this is the
    // answer to "where did my project go", and no foreign key may erase it.
    logActivity({
        area: 'project',
        event: 'project.deleted',
        level: 'warn',
        projectId: Number(req.params.id),
        detail: `${docs.length} document(s)${hadMedia ? ', media swept' : ''}`,
    });
    res.json({ success: true });
});

export const deleteRoutes = app.takeRoutes();
