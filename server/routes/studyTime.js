// /api/study-time: the study clock's record (server/studyTime.js).
//
// POST is the page's flush: entries of time on a topic, written once per
// flush id, answered with today's total so the page can show a live count.
// The two GETs are the readings the topic panel and the project dashboard draw.
import { routeTable } from './routeTable.js';
import { recordStudyTime, nodeStudyTime, projectStudyTime, StudyTimeError } from '../studyTime.js';

const app = routeTable('studyTime');

app.post('/api/study-time', (req, res) => {
    try {
        res.json(recordStudyTime(req.body));
    } catch (err) {
        if (err instanceof StudyTimeError) return res.status(400).json({ error: err.message });
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/study-time/nodes/:id', (req, res) => {
    const data = nodeStudyTime(Number(req.params.id));
    if (!data) return res.status(404).json({ error: 'Topic not found' });
    res.json(data);
});

app.get('/api/study-time/projects/:id', (req, res) => {
    const data = projectStudyTime(Number(req.params.id));
    if (!data) return res.status(404).json({ error: 'Project not found' });
    res.json(data);
});

export const routes = app.takeRoutes();
