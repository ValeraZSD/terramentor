/**
 * The study clock: how much time a learner ACTUALLY spent on a topic.
 *
 * One rule, said the way the app says it to the learner: the clock runs while
 * a screen that teaches is in front of you and you are using it. Time between
 * two of your actions counts when the pause between them is short; a longer
 * pause counts nothing, because the clock stopped at your last action; and
 * leaving the window (another tab, another app, a locked screen) ends the
 * count at the moment you left. So a lesson read for two minutes without a
 * scroll counts, and a laptop left open over lunch does not.
 *
 * TimeMe.js and Moodle's "course dedication" block measure time the same way
 * (activity events, an idle cut-off). This is ours because what it has to know
 * is not a page but WHICH TOPIC, and on the feed that changes as you scroll.
 *
 * This file is the pure half: no DOM, no timers, every call takes `now`, so
 * `tools/study-time-gates.mjs` drives it minute by minute. The browser half —
 * listening, sending, the live count — is `src/hooks/useStudyClock.ts`.
 */

export type StudyActivity = 'reading' | 'questions' | 'cards' | 'checks' | 'paper';

export const STUDY_ACTIVITIES: readonly StudyActivity[] = ['reading', 'questions', 'cards', 'checks', 'paper'];

/**
 * The longest pause that still counts, per activity.
 *
 * A card takes seconds, so two minutes on one is someone who looked away.
 * Reading a dense screen without scrolling takes a minute or two. A question
 * or a check is thinking, often on scrap paper. A written exercise is done on
 * PAPER — the screen is untouched for the whole of it, so its limit is the
 * exercise, not a pause.
 */
export const PAUSE_LIMIT_MS: Record<StudyActivity, number> = {
    cards: 2 * 60_000,
    reading: 3 * 60_000,
    questions: 5 * 60_000,
    checks: 5 * 60_000,
    paper: 30 * 60_000,
};

/**
 * Who is claiming the clock, in stacking order. A dialog over the feed (the
 * day's ledger, a confirm, an editor) is not the feed, so it sits above it and
 * claims nothing; a learning SESSION (a review, a mastery check, placement)
 * sits above both, so the dialogs it opens itself — editing the card in front
 * of you — stay part of it.
 */
export type StudyLayer = 'page' | 'dialog' | 'session';
const LAYER_RANK: Record<StudyLayer, number> = { page: 0, dialog: 1, session: 2 };

export interface StudyTarget {
    nodeId: number;
    activity: StudyActivity;
}

/** Time on one topic, doing one thing, inside one UTC hour. */
export interface StudyEntry {
    nodeId: number;
    activity: StudyActivity;
    /** `YYYY-MM-DDTHH`, UTC. */
    hour: string;
    ms: number;
}

const HOUR_MS = 3_600_000;

/** The UTC hour an instant falls in, as the record keys it: `2026-10-04T09`. */
export function hourKey(ms: number): string {
    return new Date(ms).toISOString().slice(0, 13);
}

/**
 * Cut `[from, to)` at every UTC hour boundary.
 *
 * The record is kept by the hour, not the day: an hour can be filed under
 * whichever calendar day a reader's time zone puts it in, and a day can only
 * ever be the day it was written as.
 */
export function splitByHour(from: number, to: number): { hour: string; ms: number }[] {
    const out: { hour: string; ms: number }[] = [];
    let t = from;
    while (t < to) {
        const next = Math.min(to, (Math.floor(t / HOUR_MS) + 1) * HOUR_MS);
        out.push({ hour: hourKey(t), ms: next - t });
        t = next;
    }
    return out;
}

/** Milliseconds in these entries that fall on one UTC day. */
export function sumForDay(entries: readonly StudyEntry[], day: string): number {
    let total = 0;
    for (const e of entries) if (e.hour.startsWith(day)) total += e.ms;
    return total;
}

/** What a feed card is doing to the learner, or null for one that teaches nothing. */
export function feedCardActivity(kind: string): StudyActivity | null {
    switch (kind) {
        case 'lesson':
        case 'checkpoint':
            return 'reading';
        case 'question':
        case 'recall':
            return 'questions';
        case 'flashcard':
            return 'cards';
        case 'practice':
            return 'paper';
        default:
            return null;
    }
}

const sameTarget = (a: StudyTarget | null, b: StudyTarget | null) =>
    a === b || (!!a && !!b && a.nodeId === b.nodeId && a.activity === b.activity);

export interface StudyClock {
    /** Add or update a claim. A claim keeps its place in the stack when updated. */
    claim(id: number, target: StudyTarget | null, layer: StudyLayer, now: number): void;
    release(id: number, now: number): void;
    /** The learner did something: a key, a tap, a scroll, a playing video. */
    act(now: number): void;
    /** The window stopped being in front of them. Counts up to now, then stops. */
    leave(now: number): void;
    /** The window is in front of them again. */
    arrive(now: number): void;
    isPresent(): boolean;
    current(): StudyTarget | null;
    /** What has been counted and not yet handed over. */
    pending(): StudyEntry[];
    /** Hand the counted entries over (to be sent) and forget them. */
    take(): StudyEntry[];
    /** Put back entries whose send failed, merged with what came since. */
    restore(entries: readonly StudyEntry[]): void;
}

export function createStudyClock(): StudyClock {
    const claims: { id: number; target: StudyTarget | null; layer: StudyLayer }[] = [];
    let present = false;
    /** When the learner last did something (or arrived); null when away. */
    let lastAct: number | null = null;
    /** What was on screen since `lastAct`, in order — nothing is credited until
     *  the next action proves they were still there. */
    let segments: { target: StudyTarget | null; from: number }[] = [];
    const counted = new Map<string, StudyEntry>();

    const active = (): StudyTarget | null => {
        let top: (typeof claims)[number] | null = null;
        for (const c of claims) {
            if (!top || LAYER_RANK[c.layer] >= LAYER_RANK[top.layer]) top = c;
        }
        return top ? top.target : null;
    };

    const credit = (target: StudyTarget, from: number, to: number) => {
        for (const { hour, ms } of splitByHour(from, to)) {
            const key = `${target.nodeId}|${target.activity}|${hour}`;
            const prev = counted.get(key);
            if (prev) prev.ms += ms;
            else counted.set(key, { nodeId: target.nodeId, activity: target.activity, hour, ms });
        }
    };

    const restart = (now: number) => {
        lastAct = now;
        segments = [{ target: active(), from: now }];
    };

    /** A different thing is on screen. Not an action: nothing is credited. */
    const retarget = (now: number) => {
        if (!present || lastAct == null) return;
        const next = active();
        const last = segments[segments.length - 1];
        if (last && sameTarget(last.target, next)) return;
        segments.push({ target: next, from: Math.max(now, last ? last.from : now) });
    };

    const act = (now: number) => {
        if (!present) return;
        if (lastAct == null || now < lastAct) {
            // First action, or the clock stepped backwards: start from here.
            restart(now);
            return;
        }
        const gap = now - lastAct;
        let limit = 0;
        for (const s of segments) if (s.target) limit = Math.max(limit, PAUSE_LIMIT_MS[s.target.activity]);
        if (gap <= limit) {
            segments.forEach((s, i) => {
                const to = i + 1 < segments.length ? segments[i + 1].from : now;
                if (s.target && to > s.from) credit(s.target, s.from, to);
            });
        }
        restart(now);
    };

    return {
        claim(id, target, layer, now) {
            const existing = claims.find(c => c.id === id);
            if (existing) {
                existing.target = target;
                existing.layer = layer;
            } else {
                claims.push({ id, target, layer });
            }
            retarget(now);
        },
        release(id, now) {
            const i = claims.findIndex(c => c.id === id);
            if (i < 0) return;
            claims.splice(i, 1);
            retarget(now);
        },
        act,
        leave(now) {
            if (!present) return;
            act(now);
            present = false;
            lastAct = null;
            segments = [];
        },
        arrive(now) {
            if (present) return;
            present = true;
            restart(now);
        },
        isPresent: () => present,
        current: active,
        pending: () => [...counted.values()].map(e => ({ ...e })),
        take() {
            const out = [...counted.values()];
            counted.clear();
            return out;
        },
        restore(entries) {
            for (const e of entries) {
                const key = `${e.nodeId}|${e.activity}|${e.hour}`;
                const prev = counted.get(key);
                if (prev) prev.ms += e.ms;
                else counted.set(key, { ...e });
            }
        },
    };
}

/**
 * "1 hr, 12 min" in the reader's language, rounded to the minute.
 *
 * `Intl.DurationFormat` knows every language's units and how it joins them
 * ("1 ч 12 мин", "1 h et 12 min"), so it is asked rather than taught; where it
 * is missing, the two units are said by `Intl.NumberFormat` and set side by
 * side. Nothing is never "0 min" — it is an empty string, and the caller
 * decides whether an absence is shown at all. Under half a minute is the
 * caller's own words (`underAMinute`), because "0 min" next to something you
 * did is a lie in the other direction.
 */
export function formatStudyTime(ms: number, locale: string, underAMinute: string, { compact = false } = {}): string {
    if (!(ms > 0)) return '';
    const totalMinutes = Math.round(ms / 60_000);
    if (totalMinutes === 0) return underAMinute;
    // `compact`, for a tile with room for one short value: from ten hours on,
    // whole hours only. "152 godz. i 25 min" is 460px at the poster's 56px on a
    // 456px tile, and at that scale the minutes say nothing a reader keeps.
    const roundToHours = compact && totalMinutes >= 600;
    const hours = roundToHours ? Math.round(totalMinutes / 60) : Math.floor(totalMinutes / 60);
    const minutes = roundToHours ? 0 : totalMinutes % 60;
    const parts: Record<string, number> = {};
    if (hours) parts.hours = hours;
    if (minutes || !hours) parts.minutes = minutes;
    const DF = (Intl as unknown as { DurationFormat?: new (l: string, o: object) => { format(d: object): string } }).DurationFormat;
    if (DF) {
        try { return new DF(locale, { style: 'short' }).format(parts); } catch { /* an unknown locale: fall through */ }
    }
    const unit = (value: number, u: 'hour' | 'minute') => {
        try {
            return new Intl.NumberFormat(locale, { style: 'unit', unit: u, unitDisplay: 'short' }).format(value);
        } catch {
            return `${value} ${u === 'hour' ? 'h' : 'min'}`;
        }
    };
    return [hours ? unit(hours, 'hour') : '', minutes || !hours ? unit(minutes, 'minute') : '']
        .filter(Boolean).join(' ');
}
