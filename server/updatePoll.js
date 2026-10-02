// The opt-in check for a newer release: the stored state and the background poll.
import {
    appVersion, CHECK_INTERVAL_MS, fetchLatestRelease, REPO_URL, RETRY_DELAY_MS, updateStatus,
} from './version.js';
import { getSetting, setSettingValue } from './settingsStore.js';

/** Fold the stored check into a status the UI can render. Pure read. */
function readUpdateState() {
    let latest = null;
    try {
        const raw = getSetting('update_latest', null);
        latest = raw ? JSON.parse(raw) : null;
    } catch { latest = null; }
    return {
        ...updateStatus({
            current: appVersion().version,
            latest,
            checkedAt: getSetting('update_last_check', null),
            enabled: getSetting('update_check', 'off') === 'on',
            error: getSetting('update_last_error', null) || null,
        }),
        repoUrl: REPO_URL,
        deployment: appVersion().deployment,
        updateCommand: appVersion().updateCommand,
    };
}

/**
 * Perform a check and persist the result.
 *
 * A FAILURE MUST NOT ERASE THE LAST GOOD ANSWER. One dropped request would
 * otherwise wipe a known-available update and report "up to date", which is the
 * vision-probe trap in a third costume: cache an answer, never the absence of
 * one. The error is recorded beside the answer so the panel can say the check
 * failed while still showing what it knew.
 */
async function runUpdateCheck() {
    const result = await fetchLatestRelease();
    if (result.ok) {
        setSettingValue('update_latest', result.latest ? JSON.stringify(result.latest) : '');
        setSettingValue('update_last_check', new Date().toISOString());
        setSettingValue('update_last_error', '');
    } else {
        setSettingValue('update_last_error', String(result.error).slice(0, 200));
    }
    return readUpdateState();
}

let pollTimer = null;
let retryTimer = null;

function stopUpdatePoll() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
}

/**
 * The opt-in daily poll: one call at startup, then one a day.
 *
 * `unref()` on both timers so a pending check can never be the reason the
 * process refuses to exit — a background convenience must not outrank Ctrl-C.
 * A failed startup check retries once after ten minutes, because a desktop that
 * boots the app before the network is up would otherwise go a full day blind.
 */
function startUpdatePoll({ checkNow = false } = {}) {
    stopUpdatePoll();
    if (getSetting('update_check', 'off') !== 'on') return Promise.resolve(readUpdateState());
    const tick = async () => {
        const state = await runUpdateCheck();
        if (state.error && !retryTimer) {
            retryTimer = setTimeout(() => { retryTimer = null; tick(); }, RETRY_DELAY_MS);
            retryTimer.unref?.();
        }
        return state;
    };
    pollTimer = setInterval(tick, CHECK_INTERVAL_MS);
    pollTimer.unref?.();
    // Switched on by the learner: check now, and that check is the answer.
    if (checkNow) return tick();
    // At startup, not at t=0: it is already the busiest moment in the
    // process, and nothing about this answer is needed in the first seconds.
    retryTimer = setTimeout(() => { retryTimer = null; tick(); }, 15_000);
    retryTimer.unref?.();
    return Promise.resolve(readUpdateState());
}

export { readUpdateState, runUpdateCheck, startUpdatePoll, stopUpdatePoll };
