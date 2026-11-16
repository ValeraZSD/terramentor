// /api/deleted: Recently deleted. What the learner deleted stays in the library
// until they remove it for good here (server/softDelete.js).
//
//   GET    /api/deleted                      the list, newest first
//   POST   /api/deleted/:table/:id/restore   bring a row back with what went with it
//   DELETE /api/deleted/:table/:id           remove one deleted row for good
//   DELETE /api/deleted                      remove every deleted row for good
import { CONTENT_TABLES, emptyDeleted, listDeleted, purge, restore } from '../softDelete.js';
import { logActivity } from '../activityLog.js';
import { scheduleNodeSync } from '../nodeEmbeddings.js';
import { routeTable } from './routeTable.js';

const app = routeTable('deleted');

/** `{ table, id }` from the path, or null when either is not one this list holds. */
function target(req) {
    const table = String(req.params.table || '');
    const id = Number(req.params.id);
    if (!CONTENT_TABLES.includes(table) || !Number.isInteger(id) || id <= 0) return null;
    return { table, id };
}

app.get('/api/deleted', (_req, res) => {
    res.json({ items: listDeleted() });
});

app.post('/api/deleted/:table/:id/restore', (req, res) => {
    const t = target(req);
    if (!t) return res.status(400).json({ error: 'Nothing of that kind can be restored.' });
    const out = restore(t.table, t.id);
    if (out.error === 'parent_deleted') {
        return res.status(409).json({ error: 'What this was in is deleted too. Restore that first.', code: 'parent_deleted' });
    }
    if (out.error) return res.status(404).json({ error: 'That is not in Recently deleted.' });
    if (t.table === 'projects' || t.table === 'nodes') scheduleNodeSync();
    logActivity({
        area: 'project', event: 'item.restored',
        projectId: t.table === 'projects' ? t.id : undefined,
        detail: `${t.table} · ${out.restored} row(s)`,
    });
    res.json({ restored: out.restored });
});

app.delete('/api/deleted/:table/:id', (req, res) => {
    const t = target(req);
    if (!t) return res.status(400).json({ error: 'Nothing of that kind can be removed here.' });
    const out = purge(t.table, t.id);
    if (out.error) return res.status(404).json({ error: 'That is not in Recently deleted.' });
    logActivity({ area: 'project', event: 'item.purged', level: 'warn', detail: `${t.table} · ${out.docs} document(s)` });
    res.json({ removed: true });
});

app.delete('/api/deleted', (_req, res) => {
    const removed = emptyDeleted();
    logActivity({ area: 'project', event: 'deleted.emptied', level: 'warn', detail: `${removed} item(s)` });
    res.json({ removed });
});

export const routes = app.takeRoutes();
