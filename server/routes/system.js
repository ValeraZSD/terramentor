// /api/version, /api/updates and /api/health.
import db from '../database.js';
import { appVersion, UPDATE_CHANNELS } from '../version.js';
import { setSettingValue } from '../settingsStore.js';
import { currentChannel, freshUpdateState, heardLatest, readUpdateState, runUpdateCheck, setUpdateChannel, startUpdatePoll, stopUpdatePoll } from '../updatePoll.js';
import { cancelDownload, channelChanged, dismissResult, installPending, installState, requestInstall, setChannelReader, startDownload } from '../appUpdate.js';
import { hasPasswordCredential } from '../auth.js';
import { wrap } from './request.js';
import { routeTable } from './routeTable.js';

const app = routeTable('system');

// What is staged is installed only on a channel that takes it (a nightly,
// then a switch to Stable: not ready). appUpdate.js asks the setting itself.
setChannelReader(currentChannel);

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
    // A device in without the password reads the panel but may press nothing
    // on it (server/app.js), so the page does not ask it anything.
    res.json(withInstall(req, readUpdateState()));
});

/** Every update answer carries what installing looks like on this copy (see
 *  server/appUpdate.js): whether it can, and what it is doing. And whether the
 *  device asking may press anything on the panel (server/app.js): on every
 *  answer, because the page replaces its whole status with whichever came last. */
function withInstall(req, state) {
    return { ...state, install: installState({ latest: state.latest }), controls: !req.remoteAccess || hasPasswordCredential(req) };
}

/**
 * Check now. This is the button — user-initiated, so it is allowed to reach the
 * network even when the daily poll is off. Rate-limited to one call a minute so
 * a stuck client cannot turn a button into a poll.
 */
let lastManualCheck = 0;
app.post('/api/updates/check', wrap(async (req, res) => {
    const now = Date.now();
    if (now - lastManualCheck < 60_000) {
        return res.json({ ...withInstall(req, readUpdateState()), throttled: true });
    }
    lastManualCheck = now;
    res.json(withInstall(req, await runUpdateCheck()));
}));

/** Turn the daily poll on or off. Its own endpoint rather than a generic setting
 *  write, because switching it ON is consent to an outbound call and should read
 *  that way in the code as well as in the UI — and because turning it on should
 *  answer immediately instead of leaving a blank panel until tomorrow. */
app.put('/api/updates/auto', wrap(async (req, res) => {
    const enabled = req.body?.enabled === true;
    setSettingValue('update_check', enabled ? 'on' : 'off');
    // Either answer settles the one-time "check for updates?" question.
    setSettingValue('update_check_asked', '1');
    if (!enabled) {
        stopUpdatePoll();
        return res.json(withInstall(req, readUpdateState()));
    }
    // The poll's own first tick IS this answer: one request, as SECURITY.md
    // promises, and a failed one (switched on while offline) gets the same
    // ten-minute retry a failed startup check does.
    res.json(withInstall(req, await startUpdatePoll({ checkNow: true })));
}));

/** Choose which releases this install is offered: `stable` or `nightly`. With
 *  the daily check on, the switch asks once straight away, under the same
 *  one-a-minute limit as the button, so flipping it back and forth cannot
 *  become a poll; with it off, the switch makes no request at all. */
app.put('/api/updates/channel', wrap(async (req, res) => {
    const channel = req.body?.channel;
    if (!UPDATE_CHANNELS.includes(channel)) {
        return res.status(400).json({ error: `channel must be one of: ${UPDATE_CHANNELS.join(', ')}` });
    }
    // Restart has been answered: the copy installs what was pressed, with the
    // channels its check was made with (requestInstall). A switch now would
    // name Stable while a nightly installs, so it waits until the copy has
    // opened again.
    if (installPending() && channel !== currentChannel()) {
        return res.status(409).json({ error: 'Terramentor is restarting to install an update. Change the channel once it has opened again.' });
    }
    // Only a check that will really happen spends the minute; with the daily
    // check off, "Check now" straight after the switch must still work.
    const enabled = readUpdateState().enabled;
    const now = Date.now();
    const checkNow = enabled && now - lastManualCheck >= 60_000;
    if (checkNow) lastManualCheck = now;
    // The setting is written before the check is awaited, so a download the
    // new channel does not take stops now, not after GitHub has answered.
    const switched = setUpdateChannel(channel, { checkNow });
    channelChanged();
    const state = withInstall(req, await switched);
    res.json(enabled && !checkNow ? { ...state, throttled: true } : state);
}));

/**
 * Download the newest version, in the background. The version comes from the
 * update check, never from this request: all a caller can ask for is "the
 * update you found". The press asks GitHub again first (freshUpdateState),
 * because the stored answer can be a day old and the newest release is the
 * one to fetch. Progress is read from GET.
 */
app.post('/api/updates/download', wrap(async (req, res) => {
    if (!installState().supported) return res.status(409).json({ error: 'This copy of Terramentor cannot download updates itself.' });
    // A second press, another tab or a retry while one runs starts nothing,
    // and asks nothing.
    if (installState().phase === 'downloading') return res.json(withInstall(req, readUpdateState()));
    const state = await freshUpdateState();
    // What this server heard from GitHub, never the stored row by itself.
    const latest = heardLatest();
    const install = installState({ latest });
    if (!state.available || !latest) return res.status(409).json({ error: 'No newer version has been found. Check for updates first.' });
    // Staged already, and still the newest: staging again would turn "Restart
    // to update" back into a download of what is already checked.
    if (install.phase === 'downloading' || install.phase === 'ready') return res.json(withInstall(req, state));
    startDownload({ latest });
    res.json(withInstall(req, readUpdateState()));
}));

/** "Stop download": what arrived is kept, so the next press continues. */
app.post('/api/updates/cancel', wrap(async (req, res) => {
    cancelDownload();
    res.json(withInstall(req, readUpdateState()));
}));

/** "Restart to update": the launcher takes over, the server stops, the updater
 *  swaps the staged version in and starts it (desktop/updater.js). */
app.post('/api/updates/restart', wrap(async (req, res) => {
    // Nothing to install (a Docker or git copy, nothing staged): say so
    // without asking GitHub anything.
    const before = installState();
    if (!before.supported) return res.status(409).json({ error: 'This copy of Terramentor cannot install updates itself.' });
    if (before.phase !== 'ready') return res.status(409).json({ error: 'No downloaded update is ready to install.' });
    // Asked again first, like Download: an update staged in the morning may
    // have been overtaken by the afternoon's. Then the newer one downloads
    // instead, and the page shows its progress; nothing restarts.
    await freshUpdateState();
    const latest = heardLatest();
    const out = requestInstall({ latest });
    if (!out.ok && out.overtaken && latest) {
        startDownload({ latest });
        return res.status(409).json({ error: `A newer version, ${latest.version}, came out after this one was downloaded. It is downloading now.`, overtaken: true, version: latest.version });
    }
    if (!out.ok) return res.status(out.status).json({ error: out.error });
    res.status(202).json({ restarting: true, version: out.version });
}));

/** The note about the last update (installed, or put back) has been read. */
app.post('/api/updates/result/dismiss', wrap(async (req, res) => {
    dismissResult();
    res.json(withInstall(req, readUpdateState()));
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
