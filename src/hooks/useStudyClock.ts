/**
 * The study clock in the browser: what it listens to, when it sends, and the
 * live count of today's time. The rule itself is `src/utils/studyTime.ts`.
 *
 * **Who is studying what.** A screen that teaches calls `useStudyClock` with
 * the topic in front of the learner and what they are doing with it — the
 * feed with the card under their eyes, a review session with its card, a
 * check with its topic. A dialog calls it with nothing (`Modal` does, for
 * every dialog), so the ledger opened over the feed is not time on the feed.
 *
 * **What counts as using it.** A key, a tap, a pointer moving, a wheel, a
 * scroll, typing — and a video or a clip PLAYING, because listening is
 * studying with your hands still. A widget or a p5 sketch is its own document
 * (a sandboxed frame) whose events never reach this one, so its harness posts
 * `{type: 'active'}` while it is being used. "In front of them" is the page
 * visible AND the window focused; focus inside one of our own frames is still
 * focus here (`document.hasFocus()` says so).
 *
 * **Sending.** Counted time goes to `POST /api/study-time` every half minute
 * and the moment the window is left (with `keepalive`, so a closing tab still
 * delivers it). One request at a time; a failed one is resent under the SAME
 * flush id, which the server writes once. Nothing is kept across page loads:
 * a crash costs at most the half minute since the last send, and a library
 * swapped under the same origin never receives another library's topics.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { api, newAttemptId } from '../api';
import {
    createStudyClock, sumForDay,
    type StudyEntry, type StudyLayer, type StudyTarget,
} from '../utils/studyTime';

const clock = createStudyClock();

/** How often counted time is sent while the learner studies. */
const FLUSH_EVERY_MS = 30_000;
/** Activity events closer together than this are one action. */
const ACT_EVERY_MS = 1_000;

type Batch = { flushId: string; entries: StudyEntry[] };

let installed = false;
let nextClaimId = 1;
let lastActAt = 0;

/** In flight right now; its entries are not in the server's `today` yet. */
let sending: { batch: Batch; done: Promise<void> } | null = null;
/** A send that failed, resent as it is before anything newer. */
let unsent: Batch | null = null;
/** The server's own total for its UTC day, as of the last answer. */
let today: { date: string; ms: number } | null = null;

const listeners = new Set<() => void>();
const changed = () => { for (const l of listeners) l(); };

const here = () => document.visibilityState === 'visible' && document.hasFocus();

function onActivity() {
    const now = Date.now();
    if (now - lastActAt < ACT_EVERY_MS) return;
    lastActAt = now;
    if (!clock.isPresent()) {
        if (!here()) return;
        clock.arrive(now);
    }
    clock.act(now);
    changed();
}

function leave() {
    clock.leave(Date.now());
    changed();
    void flush({ keepalive: true });
}

function arrive() {
    if (here()) clock.arrive(Date.now());
}

/**
 * Send what has been counted. `ask` sends even an empty flush, which is how a
 * page learns today's total before it has counted anything.
 */
function flush({ keepalive = false, ask = false } = {}): Promise<void> {
    if (sending) return sending.done;
    let batch = unsent;
    if (!batch) {
        const entries = clock.take();
        if (entries.length || ask) batch = { flushId: newAttemptId(), entries };
    }
    if (!batch) return Promise.resolve();
    unsent = null;
    const current = batch;
    const done = api.sendStudyTime(current, keepalive)
        .then(r => {
            today = { date: r.date, ms: r.todayMs };
        })
        .catch(() => {
            unsent = current;
        })
        .finally(() => {
            sending = null;
            changed();
        });
    sending = { batch: current, done };
    return done;
}

function install() {
    if (installed || typeof window === 'undefined') return;
    installed = true;
    const quiet = { capture: true, passive: true } as const;
    for (const type of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'input']) {
        window.addEventListener(type, onActivity, quiet);
    }
    // Neither bubbles; both reach a capturing listener on the document.
    document.addEventListener('scroll', onActivity, quiet);
    document.addEventListener('timeupdate', onActivity, quiet);
    window.addEventListener('message', (e: MessageEvent) => {
        const d = e.data;
        if (d && typeof d === 'object' && d.type === 'active'
            && (typeof d.__widget === 'string' || typeof d.__p5 === 'string')) onActivity();
    });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') leave();
        else arrive();
    });
    // Focus moving into one of our own frames blurs the window too, and is not
    // leaving — so ask after the move has settled.
    window.addEventListener('blur', () => setTimeout(() => { if (!document.hasFocus()) leave(); }, 0));
    window.addEventListener('focus', arrive);
    window.addEventListener('pagehide', leave);
    setInterval(() => { void flush(); }, FLUSH_EVERY_MS);
    arrive();
}

/**
 * Claim the clock for whatever this screen is teaching.
 *
 * `target` null while it is on screen and teaching nothing (still loading, a
 * results page, a dialog) — it still covers what is beneath it. `enabled`
 * false takes the claim away entirely.
 */
export function useStudyClock(
    target: StudyTarget | null,
    { enabled = true, layer = 'page' }: { enabled?: boolean; layer?: StudyLayer } = {},
): void {
    const id = useRef(0);
    if (!id.current) id.current = nextClaimId++;
    const nodeId = target?.nodeId ?? null;
    const activity = target?.activity ?? null;

    useEffect(() => {
        if (!enabled) return;
        install();
        const claimId = id.current;
        return () => clock.release(claimId, Date.now());
    }, [enabled]);

    useEffect(() => {
        if (!enabled) return;
        clock.claim(id.current, nodeId != null && activity ? { nodeId, activity } : null, layer, Date.now());
    }, [enabled, nodeId, activity, layer]);
}

/** Today's total with what is counted but not yet sent, or null until the server has answered once. */
function liveToday(): number | null {
    if (!today) return null;
    const unanswered = [...clock.pending(), ...(sending?.batch.entries ?? []), ...(unsent?.entries ?? [])];
    return today.ms + sumForDay(unanswered, today.date);
}

const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => { listeners.delete(l); };
};

/**
 * Today's study time across the library, live. In half-minute steps, so a
 * subscriber re-renders when the shown value can change and not on every
 * scroll event.
 */
export function useStudyTimeToday(): number | null {
    useEffect(() => {
        install();
        if (!today) void flush({ ask: true });
    }, []);
    return useSyncExternalStore(subscribe, () => {
        const ms = liveToday();
        return ms == null ? null : Math.floor(ms / 30_000) * 30_000;
    });
}

/**
 * Send what is counted now and wait for it — before reading a total from the
 * server. Twice: a send already in flight is waited for, then whatever was
 * counted while it was out goes too.
 */
export async function flushStudyTime(): Promise<void> {
    await flush();
    await flush();
}
