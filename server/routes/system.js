// /api/version, /api/updates and /api/health.
import db from '../database.js';
import { appVersion } from '../version.js';
import { setSettingValue } from '../settingsStore.js';
import { readUpdateState, runUpdateCheck, startUpdatePoll, stopUpdatePoll } from '../updatePoll.js';
import { wrap } from './request.js';
import { routeTable } from './routeTable.js';

const app = routeTable('system');

// VERSION AND UPDATES
//
// See server/version.js for why the check is shaped the way it is. The short
// version: identity is free and always on, the network call is a button by
// default, and the daily poll is opt-in so SECURITY.md's "start it, sit idle,
// capture nothing" procedure stays literally true on a default install.

/** Who am I. No network, no database — safe to call from anywhere, including
 *  the "report a problem" builder, which needs it before anything else works. */
app.get('/api/version', (req, res) => {
    res.json(appVersion());
});

/** Read the last check's result. Deliberately does NOT check: a GET that reaches
 *  the network as a side effect is exactly the ping this design refuses. */
app.get('/api/updates', (req, res) => {
    res.json(readUpdateState());
});

/**
 * Check now. This is the button — user-initiated, so it is allowed to reach the
 * network even when the daily poll is off. Rate-limited to one call a minute so
 * a stuck client cannot turn a button into a poll.
 */
let lastManualCheck = 0;
app.post('/api/updates/check', wrap(async (req, res) => {
    const now = Date.now();
    if (now - lastManualCheck < 60_000) {
        return res.json({ ...readUpdateState(), throttled: true });
    }
    lastManualCheck = now;
    res.json(await runUpdateCheck());
}));

/** Turn the daily poll on or off. Its own endpoint rather than a generic setting
 *  write, because switching it ON is consent to an outbound call and should read
 *  that way in the code as well as in the UI — and because turning it on should
 *  answer immediately instead of leaving a blank panel until tomorrow. */
app.put('/api/updates/auto', wrap(async (req, res) => {
    const enabled = req.body?.enabled === true;
    setSettingValue('update_check', enabled ? 'on' : 'off');
    if (!enabled) {
        stopUpdatePoll();
        return res.json(readUpdateState());
    }
    // The poll's own first tick IS this answer: one request, as SECURITY.md
    // promises, and a failed one (switched on while offline) gets the same
    // ten-minute retry a failed startup check does.
    res.json(await startUpdatePoll({ checkNow: true }));
}));

// Health check (no DB dependency)
app.get('/api/health', (req, res) => {
    let dbOk = false;
    try {
        db.prepare('SELECT 1').get();
        dbOk = true;
    } catch (_) { }
    res.json({
        status: dbOk ? 'ok' : 'degraded',
        database: dbOk ? 'connected' : 'error',
        uptime: process.uptime(),
    });
});

export const routes = app.takeRoutes();
