// /api/projects/:projectId/completion: the finished-project screen.
import { markCelebrated, projectCompletion } from '../completion.js';
import { requireProject } from './projectRows.js';
import { routeTable } from './routeTable.js';

const app = routeTable('completion');

// Is this project finished, and what did finishing it take? (server/completion.js)
//
// Always 200 with a payload — `complete: false` is the normal answer and the
// client needs the rest of it anyway to offer the summary from the project's
// own menu after the fact.
app.get('/api/projects/:projectId/completion', (req, res) => {
    const { projectId } = req.params;
    try {
        const summary = projectCompletion(projectId);
        if (!summary) return res.status(404).json({ error: 'Project not found' });
        res.json(summary);
    } catch (err) {
        console.error('[Completion] Error:', err);
        res.status(500).json({ error: `Failed to summarise the project: ${err.message}` });
    }
});

// "I have seen this." Stops the summary opening itself again — and nothing
// else: the project's status is changed through the ordinary PUT, because
// moving a project to Completed is a decision and closing a dialog is not.
app.post('/api/projects/:projectId/completion/seen', (req, res) => {
    const { projectId } = req.params;
    if (!requireProject(req, res)) return;
    try {
        markCelebrated(projectId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: `Failed to record that: ${err.message}` });
    }
});

export const routes = app.takeRoutes();
