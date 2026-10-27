// The opt-in check for a newer release: the stored state and the background poll.
import {
    appVersion, CHECK_INTERVAL_MS, fetchLatestRelease, REPO_URL, RETRY_DELAY_MS, updateChannel, updateStatus,
} from './version.js';
import { getSetting, setSettingValue } from './settingsStore.js';

const currentChannel = () => updateChannel(getSetting('update_channel', 'stable'));

/** Fold the stored check into a status the UI can render. Pure read. */
function readUpdateState() {
    const channel = currentChannel();
    // A stored answer is to the question its channel asked. One written before
    // channels existed was stable's, and an answer for the other channel (the
    // setting changed by some path that did not clear it) reads as "not
    // checked", never as this channel's answer.
    const answered = updateChannel(getSetting('update_answer_channel', 'stable')) === channel;
    let latest = null;
    try {
        const raw = answered ? getSetting('update_latest', null) : null;
        latest = raw ? JSON.parse(raw) : null;
    } catch { latest = null; }
    return {
        ...updateStatus({
            current: appVersion().version,
            latest,
            checkedAt: answered ? getSetting('update_last_check', null) : null,
            enabled: getSetting('update_check', 'off') === 'on',
            error: answered ? getSetting('update_last_error', null) || null : null,
            channel,
        }),
        repoUrl: REPO_URL,
        // Whether the person has answered "check for updates?" once, either way.
        asked: getSetting('update_check_asked', '') === '1',
        deployment: appVersion().deployment,
        updateCommand: appVersion().updateCommand,
    };
}

/** The answer this process last received from GitHub, as it was stored. */
let heard = null;

/**
 * The release a Download or Restart may act on: the stored answer, only while
 * it is the one this process received itself. A row it did not receive (left
 * by an older version, or written by any path but the check) is no offer;
 * `freshUpdateState` asks GitHub instead of trusting it.
 */
function heardLatest() {
    const raw = getSetting('update_latest', null) || '';
    if (!heard || raw !== heard.raw || !raw || currentChannel() !== heard.channel
        || updateChannel(getSetting('update_answer_channel', 'stable')) !== heard.channel) return null;
    try { return JSON.parse(raw); } catch { return null; }
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
    const channel = currentChannel();
    const result = await fetchLatestRelease(undefined, { channel });
    // Switched while this one was in flight: its answer is to a question
    // nobody is asking any more, and writing it would overwrite the new
    // channel's (or leave the panel blank until tomorrow).
    if (currentChannel() !== channel) return readUpdateState();
    if (result.ok) {
        heard = { raw: result.latest ? JSON.stringify(result.latest) : '', channel };
        setSettingValue('update_latest', heard.raw);
        setSettingValue('update_last_check', new Date().toISOString());
        setSettingValue('update_last_error', '');
        setSettingValue('update_answer_channel', channel);
    } else {
        // The stored answer may be the other channel's (the channel changed by
        // a path that did not clear it). A failure on this channel then takes
        // the slot over, so the error is shown, and retried, instead of being
        // read as "not checked".
        if (updateChannel(getSetting('update_answer_channel', 'stable')) !== channel) {
            setSettingValue('update_latest', '');
            setSettingValue('update_last_check', '');
            setSettingValue('update_answer_channel', channel);
        }
        setSettingValue('update_last_error', String(result.error).slice(0, 200));
    }
    return readUpdateState();
}

/** When a press last made `freshUpdateState` ask, so that a button pressed
 *  over and over while offline (where no answer is stored) asks once a minute;
 *  and the ask under way, which a second press joins rather than reading the
 *  old answer beside it. */
let lastFreshAsk = 0;
let freshAsk = null;

/**
 * The answer a press acts on: Download, and Restart to update. The stored one
 * can be a day old, since the daily poll is once a day and Check now only
 * when pressed, and a nightly comes out every few hours. Acting on it
 * downloaded a version that was already superseded, then offered the newer
 * one straight after the restart (seen on 22 and 26 Oct 2026). So the press
 * asks again first, unless the answer is under a minute old. It is the
 * person pressing, the same consent as Check now, and the same single
 * request. A failed ask keeps the stored answer (runUpdateCheck), so the
 * press still works offline with what this process heard (`heardLatest`);
 * after a restart it has heard nothing until one check succeeds, while a
 * version already staged still installs.
 */
async function freshUpdateState({ now = Date.now(), maxAgeMs = 60_000 } = {}) {
    if (freshAsk) return freshAsk;
    const state = readUpdateState();
    const checked = Date.parse(state.checkedAt || '') || 0;
    // Two separate tests. The last ask throttles on its own: offline, the
    // stored answer never gets fresher, and with it dated ahead (the clock
    // set back) a combined age would be negative on every press. An answer
    // dated ahead counts as old, not as fresh forever.
    const sinceAsk = now - lastFreshAsk;
    if (sinceAsk >= 0 && sinceAsk < maxAgeMs) return state;
    const age = now - checked;
    if (age >= 0 && age < maxAgeMs && (heardLatest() || !getSetting('update_latest', null))) return state;
    lastFreshAsk = now;
    freshAsk = runUpdateCheck().finally(() => { freshAsk = null; });
    return freshAsk;
}

/**
 * Switch between the stable and nightly channels.
 *
 * The stored answer was to the other channel's question, so it goes; keeping
 * it would show a nightly as "available" to an install that just chose stable.
 * Nothing is downgraded either way: a nightly install switched to stable is
 * offered nothing until a stable release is newer than it (updateStatus).
 *
 * With the daily check on, the switch asks once straight away, the same single
 * request turning the check on makes; `checkNow: false` is the caller's rate
 * limit. With it off, nothing reaches the network (startUpdatePoll returns
 * without asking): the switch only changes what "Check now" will ask.
 */
async function setUpdateChannel(channel, { checkNow = true } = {}) {
    const next = updateChannel(channel);
    setSettingValue('update_channel', next);
    setSettingValue('update_latest', '');
    setSettingValue('update_last_check', '');
    setSettingValue('update_last_error', '');
    setSettingValue('update_answer_channel', next);
    return checkNow ? startUpdatePoll({ checkNow: true }) : readUpdateState();
}

let pollTimer = null;
let retryTimer = null;
// Which poll is current. A check already in flight when the poll is stopped
// (checks turned off, or restarted by a channel switch) finishes, but must not
// arm a retry for a poll that no longer exists: that would be a request after
// the learner said no.
let pollGeneration = 0;

function stopUpdatePoll() {
    pollGeneration++;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
}

/**
 * The opt-in daily poll: one call at startup, then one a day.
 *
 * `unref()` on both timers so a pending check can never be the reason the
 * process refuses to exit — a background convenience must not outrank Ctrl-C.
 * A failed scheduled check retries ONCE after ten minutes, because a desktop
 * that boots the app before the network is up would otherwise go a full day
 * blind. The retry itself never schedules another: offline, or rate-limited by
 * GitHub, the app asks twice and then waits for tomorrow, as SECURITY.md says.
 */
function startUpdatePoll({ checkNow = false } = {}) {
    stopUpdatePoll();
    if (getSetting('update_check', 'off') !== 'on') return Promise.resolve(readUpdateState());
    const generation = pollGeneration;
    const tick = async ({ isRetry = false } = {}) => {
        const state = await runUpdateCheck();
        if (state.error && !isRetry && !retryTimer && generation === pollGeneration) {
            retryTimer = setTimeout(() => { retryTimer = null; tick({ isRetry: true }); }, RETRY_DELAY_MS);
            retryTimer.unref?.();
        }
        return state;
    };
    pollTimer = setInterval(() => tick(), CHECK_INTERVAL_MS);
    pollTimer.unref?.();
    // Switched on by the learner: check now, and that check is the answer.
    if (checkNow) return tick();
    // At startup, not at t=0: it is already the busiest moment in the
    // process, and nothing about this answer is needed in the first seconds.
    retryTimer = setTimeout(() => { retryTimer = null; tick(); }, 15_000);
    retryTimer.unref?.();
    return Promise.resolve(readUpdateState());
}

export { freshUpdateState, heardLatest, readUpdateState, runUpdateCheck, setUpdateChannel, startUpdatePoll, stopUpdatePoll };
