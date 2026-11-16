// The opt-in check for a newer release: the stored state and the automatic check.
import {
    appVersion, CHECK_INTERVAL_MS, DUE_TICK_MS, fetchLatestRelease, REPO_URL, RETRY_DELAYS_MS, updateChannel, updateStatus, WAKE_RECHECK_MS,
} from './version.js';
import { getSetting, setSettingValue } from './settingsStore.js';

const currentChannel = () => updateChannel(getSetting('update_channel', 'stable'));

/** What the automatic check's schedule needs to know, in this process only:
 *  a new process asks once at startup anyway. Times are wall-clock ms. */
const schedule = { lastAttemptAt: 0, lastSuccessAt: 0, failures: 0, lastTickAt: 0 };

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
    // channel's (or leave the panel blank until tomorrow). Nor does it count
    // for the schedule: a success here would push the new channel's retry
    // four hours out.
    if (currentChannel() !== channel) return readUpdateState();
    // Every check counts for the schedule, a press of Check now included, so a
    // pressed check is not followed by a scheduled one a minute later.
    const at = Date.now();
    schedule.lastAttemptAt = at;
    if (result.ok) { schedule.lastSuccessAt = at; schedule.failures = 0; } else schedule.failures++;
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
 * can be hours old (the automatic check asks every few hours, Check now only
 * when pressed), and a nightly comes out every few hours. Acting on it
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
 * With the automatic check on, the switch asks once straight away, the same single
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
    if (checkNow) return startUpdatePoll({ checkNow: true });
    // Not now (the caller's one-a-minute limit), but the new channel has no
    // answer at all: the poll's next look, within the minute, asks for it
    // instead of the panel saying "not checked" for hours.
    schedule.lastAttemptAt = 0;
    return readUpdateState();
}

/**
 * Whether the automatic check should ask now. Pure, so a gate can walk it
 * through hours, failures and a sleep without a clock (`now` is passed in).
 *
 * - Never asked in this process: due (the startup check).
 * - After a failure: due once the back-off step for that failure has passed
 *   (RETRY_DELAYS_MS), then every CHECK_INTERVAL_MS while it keeps failing.
 * - After a success: due CHECK_INTERVAL_MS later.
 * - Back from sleep (`now` is more than three ticks past the last tick): due if
 *   the last answer is older than WAKE_RECHECK_MS.
 * - The clock set back behind the last ask: due, rather than silent until the
 *   clock catches up again.
 */
function checkIsDue({ now, lastAttemptAt, lastSuccessAt, failures, lastTickAt }) {
    if (!lastAttemptAt || now < lastAttemptAt) return true;
    const woke = lastTickAt > 0 && now - lastTickAt > 3 * DUE_TICK_MS;
    if (woke && now - lastSuccessAt >= WAKE_RECHECK_MS) return true;
    const wait = failures > 0 ? (RETRY_DELAYS_MS[failures - 1] ?? CHECK_INTERVAL_MS) : CHECK_INTERVAL_MS;
    return now - lastAttemptAt >= wait;
}

let pollTimer = null;
let startTimer = null;
let scheduledCheck = null;
// Which poll is current. A tick of a poll that was stopped (checks turned off,
// or restarted by a channel switch) must not ask: that would be a request after
// the learner said no.
let pollGeneration = 0;

function stopUpdatePoll() {
    pollGeneration++;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (startTimer) { clearTimeout(startTimer); startTimer = null; }
}

/**
 * The opt-in automatic check: once at startup, then every CHECK_INTERVAL_MS,
 * with back-off retries after a failure and a prompt ask after the computer
 * wakes from sleep (checkIsDue).
 *
 * Driven by the WALL clock, looked at once a minute, never by one long timer:
 * a 24-hour setInterval does not count the hours a laptop sleeps, so a copy
 * that slept every night could go days without asking. A look is a comparison
 * and makes no request.
 *
 * `unref()` on both timers so a pending check can never be the reason the
 * process refuses to exit — a background convenience must not outrank Ctrl-C.
 */
function startUpdatePoll({ checkNow = false } = {}) {
    stopUpdatePoll();
    if (getSetting('update_check', 'off') !== 'on') return Promise.resolve(readUpdateState());
    const generation = pollGeneration;
    const ask = () => {
        if (!scheduledCheck) scheduledCheck = runUpdateCheck().finally(() => { scheduledCheck = null; });
        return scheduledCheck;
    };
    const tick = () => {
        if (generation !== pollGeneration) return;
        const now = Date.now();
        const due = checkIsDue({ now, ...schedule });
        schedule.lastTickAt = now;
        if (due) ask().catch(() => { /* runUpdateCheck never throws; the settings write could */ });
    };
    pollTimer = setInterval(tick, DUE_TICK_MS);
    pollTimer.unref?.();
    // Switched on by the learner: check now, and that check is the answer. Not
    // joined to a scheduled one in flight: after a channel switch that one
    // asked the old channel's question and its answer is dropped.
    if (checkNow) { schedule.lastTickAt = Date.now(); return runUpdateCheck(); }
    // At startup, not at t=0: it is already the busiest moment in the
    // process, and nothing about this answer is needed in the first seconds.
    startTimer = setTimeout(() => { startTimer = null; tick(); }, 15_000);
    startTimer.unref?.();
    return Promise.resolve(readUpdateState());
}

/** For the gate: the schedule's state, and a way to set it. */
const updateScheduleForTest = {
    get: () => ({ ...schedule }),
    set: (s) => Object.assign(schedule, s),
};

export {
    checkIsDue, currentChannel, freshUpdateState, heardLatest, readUpdateState, runUpdateCheck, setUpdateChannel, startUpdatePoll, stopUpdatePoll,
    updateScheduleForTest,
};
