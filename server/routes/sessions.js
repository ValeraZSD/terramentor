// /api/sessions: a finished study session.
import db from '../database.js';
import { routeTable } from './routeTable.js';

const app = routeTable('sessions');

// SESSIONS

app.post('/api/sessions', (req, res) => {
    const { projectId, nodeId, activityType, durationSeconds, metadata } = req.body;
    const result = db.prepare('INSERT INTO learning_sessions (project_id, node_id, activity_type, duration_seconds, metadata) VALUES (?, ?, ?, ?, ?)')
        .run(projectId, nodeId || null, activityType, durationSeconds || 0, metadata ? JSON.stringify(metadata) : null);
    res.json({ id: result.lastInsertRowid });
});

export const routes = app.takeRoutes();
