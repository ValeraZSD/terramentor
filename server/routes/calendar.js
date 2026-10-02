// /api/calendar.
import { buildCalendarRange } from '../today.js';
import { routeTable } from './routeTable.js';

const app = routeTable('calendar');

// Global calendar feed: scheduled leaves of active projects in a date range.
// GlobalCalendarView's swipe carousel fetches the whole prev→next window in one
// request; in month mode that's three consecutive 6-week grids (up to ~104 days),
// so the cap must clear three month-grids with headroom. The query is a single
// range scan (cost is span-independent), so a generous bound is free.
const CALENDAR_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CALENDAR_MAX_RANGE_DAYS = 120;

app.get('/api/calendar', (req, res) => {
    const { from, to } = req.query;
    if (!CALENDAR_DATE_RE.test(from || '') || !CALENDAR_DATE_RE.test(to || '')) {
        return res.status(400).json({ error: 'from and to must be YYYY-MM-DD' });
    }
    const spanDays = (Date.parse(to) - Date.parse(from)) / 86400000;
    if (!(spanDays >= 0 && spanDays <= CALENDAR_MAX_RANGE_DAYS)) {
        return res.status(400).json({ error: `Range must be 0-${CALENDAR_MAX_RANGE_DAYS} days` });
    }
    try {
        res.json(buildCalendarRange(from, to));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export const routes = app.takeRoutes();
