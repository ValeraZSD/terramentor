// /api/tasks: the background task registry, its streams, cancel and dismiss.
import * as tasks from '../tasks.js';
import { attachTaskStream, startSseResponse } from './taskStream.js';
import { routeTable } from './routeTable.js';

const app = routeTable('tasks');

app.get('/api/tasks', (req, res) => {
    res.json(tasks.listTasks());
});

// Live task-list feed for the global dock: a full snapshot on connect, then a
// coalesced snapshot whenever anything changes (status, progress, queue order).
app.get('/api/tasks/stream', (req, res) => {
    const { write, stopKeepAlive } = startSseResponse(req, res);
    write({ tasks: tasks.listTasks() });
    const unsub = tasks.onListChange((list) => write({ tasks: list }));
    res.on('close', () => { stopKeepAlive(); unsub(); });
});

app.get('/api/tasks/:id/stream', (req, res) => {
    attachTaskStream(req, res, req.params.id);
});

app.post('/api/tasks/:id/cancel', (req, res) => {
    const result = tasks.cancelTask(req.params.id);
    if (!result.ok) return res.status(404).json({ error: result.error });
    res.json({ success: true });
});

// Dismiss a finished task from the list (the dock's ✕ on a done/failed chip).
app.delete('/api/tasks/:id', (req, res) => {
    const result = tasks.dismissTask(req.params.id);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ success: true });
});

export const routes = app.takeRoutes();
