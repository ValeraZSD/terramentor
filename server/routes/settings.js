// /api/settings and /api/activity: the settings rows and the local activity log.
import db from '../database.js';
import { isSecretSettingKey } from '../auth.js';
import {
    activityStats, clearActivityLog, invalidateActivityLogSetting, logActivity, readActivity,
    streamActivityLog,
} from '../activityLog.js';
import { ICON_SETTING_KEYS } from '../iconArt.js';
import { refreshDesktopIcon } from '../desktopIcon.js';
import { currentAppIcon } from '../appIconSettings.js';
import { routeTable } from './routeTable.js';

const app = routeTable('settings');

// Settings (wrapped)
app.get('/api/settings', (req, res) => {
    try {
        const settings = db.prepare('SELECT * FROM settings').all();
        const result = {};
        // Never expose secrets through the generic settings dump — it is
        // readable by anything that can reach the app's origin, so it carries
        // preferences and nothing credential-shaped: the auth rows are managed
        // via /api/auth/*, and the cloud provider key via /api/ai/key (the AI
        // panel learns whether a key is saved from /api/ai/status, never its
        // value).
        settings.forEach(s => { if (!isSecretSettingKey(s.key)) result[s.key] = s.value; });
        res.json(result);
    } catch (err) {
        console.error('[Settings] DB error:', err.message);
        res.status(500).json({ error: 'Failed to load settings', detail: err.message });
    }
});

app.put('/api/settings/:key', (req, res) => {
    // Secrets are managed only through their own endpoints (/api/auth/*, and
    // /api/ai/key for the provider key) — block the generic writer so a client
    // can't overwrite the password hash, the session secret or the key.
    if (isSecretSettingKey(req.params.key)) {
        return res.status(403).json({ error: 'This setting is managed via the security or AI settings' });
    }
    const { value } = req.body;
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(req.params.key, value);
    // The log reads its own switch through a cache, so the switch has to say
    // when it moved. (Written before the log line below, so turning it ON
    // records that it was turned on and turning it OFF records nothing.)
    if (req.params.key === 'activity_log_enabled') invalidateActivityLogSetting();
    // The three icon rows also own a FILE: on a packaged Windows install the
    // tray and every shortcut draw `<install>/Terramentor.ico`, so changing the
    // icon here has to rewrite it or the app looks like one thing in its tab and
    // another everywhere Windows draws it. Not awaited — a few milliseconds of
    // rasterising must not sit between a press and its answer — and it cannot
    // throw (`desktopIcon.js` returns its failures).
    if (Object.values(ICON_SETTING_KEYS).includes(req.params.key)) {
        void refreshDesktopIcon(currentAppIcon());
    }
    res.json({ success: true });
});

// THE LOCAL ACTIVITY LOG
//
// Read, export, clear. Nothing here reaches the network — the export is a file
// the person downloads and decides what to do with, in the same spirit as the
// bug-report block (src/utils/report.ts): the app assembles the facts, the
// person presses send, somewhere else.

app.get('/api/activity', (req, res) => {
    const { limit, level, area, before } = req.query;
    res.json({
        stats: activityStats(),
        events: readActivity({
            limit: limit ? Number(limit) : 50,
            level: level ? String(level) : null,
            area: area ? String(area) : null,
            before: before ? Number(before) : null,
        }),
    });
});

app.get('/api/activity/export', (req, res) => {
    // Streamed, not built: the cap is 20k rows and this runs on the machine the
    // app is already the heaviest thing on.
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="terramentor-activity-${stamp}.log"`);
    try {
        for (const chunk of streamActivityLog()) res.write(chunk);
        res.end();
    } catch (e) {
        // Headers are already out by then, so there is no status left to send;
        // saying so INSIDE the file beats a truncated download that looks whole.
        res.end(`\n# export failed: ${e.message}\n`);
    }
});

app.delete('/api/activity', (req, res) => {
    const ok = clearActivityLog();
    logActivity({ area: 'server', event: 'activity.cleared' });
    res.json({ success: ok });
});

export const routes = app.takeRoutes();
