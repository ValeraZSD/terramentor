// Reports the client knows about, by ref, and the items on the learner's screen.
//
// One store behind every flag: a report filed on the feed shows as reported in
// the assistant's proposal and the other way round, and an Undo anywhere
// clears it everywhere. The screen list is what the assistant drawer sends with
// a turn (`ScreenItem`: a ref and what the screen showed); the server reads the
// items themselves.
import { useCallback, useEffect } from 'react';
import { create } from 'zustand';
import { api } from '../api';
import type { ItemReport, ScreenItem } from './itemReports';

/** How many items the assistant hears about: the one on screen and the ones
 *  before it, or a whole results list (a mastery check asks up to 30). */
const SCREEN_ITEMS = 30;
/** The server reads at most this many refs in one request. */
const REFS_PER_REQUEST = 100;

interface ScreenEntry extends ScreenItem { current: boolean }

interface ItemReportState {
    /** A report standing on the ref, null when it has none (or it was undone). */
    byRef: Record<string, ItemReport | null>;
    screen: ScreenEntry[];
    setReport: (ref: string, report: ItemReport | null) => void;
    /** `setReport` for an answer asked at `mark` (`reportWriteMark()`): skipped when the ref was written since. */
    setReportSince: (ref: string, report: ItemReport | null, mark: number) => void;
    /** Feed copies their own report took off the stream before they were done, by the copy's
     *  feed key, each naming the item reported (`useSetAside`). A card can be in the feed twice. */
    aside: Record<string, string>;
    /** Set the copy aside for the item `ref`, or clear it with null. */
    setAside: (copy: string, ref: string | null) => void;
    /** Ask the server which of these refs stand reported; refs already known are skipped. */
    load: (refs: string[]) => Promise<void>;
    /** Ask again about refs whose report may have changed on the server (a reported card was edited). */
    refresh: (refs: string[]) => Promise<void>;
    /** List an item; `current` (the default) makes it the one the learner is on. */
    showItem: (item: ScreenItem, current?: boolean) => void;
    leaveItem: (ref: string) => void;
}

// Every flag on a results screen asks about its own item as it mounts; the
// refs asked for in one tick go to the server as one request.
let queued = new Set<string>();
let flush: Promise<void> | null = null;
/** Asked and not answered yet: a second mount meanwhile does not ask again. */
const asking = new Set<string>();
/** When each ref was last written by `setReport` (a press, an Undo, a preview), by a running count. */
let writes = 0;
const writtenAt = new Map<string, number>();
/** Written after `mark`: a report filed or undone while an answer was on its way is newer than that answer. */
const writtenSince = (ref: string, mark: number) => (writtenAt.get(ref) ?? -1) > mark;

/** Taken before asking the server about a ref, and passed to `setReportSince` with its answer. */
export function reportWriteMark(): number {
    return writes;
}

/** Each list request by a running count, and per ref the count of the answer last applied. */
let asks = 0;
const appliedAsk = new Map<string, number>();

async function ask(refs: string[]): Promise<void> {
    for (let i = 0; i < refs.length; i += REFS_PER_REQUEST) {
        const part = refs.slice(i, i + REFS_PER_REQUEST);
        for (const r of part) asking.add(r);
        const askedAt = writes;
        const asked = ++asks;
        try {
            const { reports } = await api.listItemReports({ refs: part });
            // The list's answer must not write over a newer report, nor over
            // the answer to a list asked after it (two saves of one card each
            // ask, and the answers can arrive in either order). A newer ask
            // that failed applied nothing, so it does not stop this one.
            const stale = (r: string) => writtenSince(r, askedAt) || (appliedAsk.get(r) ?? -1) > asked;
            const answer = new Map<string, ItemReport | null>();
            for (const r of part) if (!stale(r)) answer.set(r, null);
            for (const r of reports) if (!stale(r.ref)) answer.set(r.ref, r);
            for (const r of answer.keys()) appliedAsk.set(r, asked);
            useItemReports.setState(s => ({ byRef: { ...s.byRef, ...Object.fromEntries(answer) } }));
        } catch { /* the flag works without knowing: a second report returns the standing one */ }
        finally { for (const r of part) asking.delete(r); }
    }
}

export const useItemReports = create<ItemReportState>((set, get) => ({
    byRef: {},
    screen: [],
    setReport: (ref, report) => {
        writtenAt.set(ref, ++writes);
        set(s => ({ byRef: { ...s.byRef, [ref]: report && !report.undoneAt ? report : null } }));
    },
    setReportSince: (ref, report, mark) => {
        if (!writtenSince(ref, mark)) get().setReport(ref, report);
    },
    aside: {},
    setAside: (copy, ref) => set(s => {
        if ((s.aside[copy] ?? null) === ref) return s;
        const aside = { ...s.aside };
        if (ref) aside[copy] = ref;
        else delete aside[copy];
        return { aside };
    }),
    load: (refs) => {
        const known = get().byRef;
        for (const r of refs) if (r && !(r in known) && !asking.has(r)) queued.add(r);
        if (!queued.size) return flush ?? Promise.resolve();
        flush ??= Promise.resolve().then(() => {
            const wanted = [...queued];
            queued = new Set();
            flush = null;
            return ask(wanted);
        });
        return flush;
    },
    refresh: (refs) => ask([...new Set(refs.filter(Boolean))]),
    showItem: (item, current = true) => set(s => {
        const rest = s.screen.filter(e => e.ref !== item.ref);
        if (current) return { screen: [{ ...item, current: true }, ...rest.map(e => ({ ...e, current: false }))].slice(0, SCREEN_ITEMS) };
        // Listed, not claiming the screen: the item the learner IS on keeps its
        // place at the head, or a feed paging in behind a sitting pushes it out.
        const was = s.screen.find(e => e.ref === item.ref)?.current ?? false;
        const head = rest.filter(e => e.current);
        return { screen: [...head, { ...item, current: was }, ...rest.filter(e => !e.current)].slice(0, SCREEN_ITEMS) };
    }),
    leaveItem: (ref) => set(s => ({ screen: s.screen.map(e => (e.ref === ref ? { ...e, current: false } : e)) })),
}));

/** A card set aside by its report goes back to the feed once the store knows the report no longer holds. */
export function asideReleased({ aside, known, holds }: { aside: boolean; known: boolean; holds: boolean }): boolean {
    return aside && known && !holds;
}

/** Whether this feed copy was set aside by a report on `ref`. */
export function asideOf(aside: Record<string, string>, copy: string, ref: string | null): boolean {
    return !!ref && aside[copy] === ref;
}

/**
 * A feed card taken off the stream by its own report before it was done. The
 * report marks the card done so the stream moves past it; once the report no
 * longer holds (undone here or anywhere else, or the card edited) `release`
 * takes that mark back, also when the feed mounts the card again later,
 * because the mark is kept here and not in the card. A card done before it was
 * reported is never set aside: Undo gives it back done. `setAside` is called
 * by the flag's `onReported` when the card was not done yet. The mark is the
 * COPY's (`copy`, its feed key): a card rated and requeued is in the feed twice,
 * and an Undo of a report on the second copy leaves the rated first one done.
 */
export function useSetAside(ref: string | null, copy: string, holds: boolean, release: () => void) {
    const aside = useItemReports(s => asideOf(s.aside, copy, ref));
    const known = useItemReports(s => !!ref && ref in s.byRef);
    const free = asideReleased({ aside, known, holds });
    useEffect(() => {
        if (!free) return;
        useItemReports.getState().setAside(copy, null);
        release();
    }, [free, copy, release]);
    const setAside = useCallback(() => { if (ref) useItemReports.getState().setAside(copy, ref); }, [copy, ref]);
    return { aside, setAside };
}

/**
 * Whether the screen list says the learner saw this item's key: a verdict on
 * the screen or a key shown (a card turned over), as the server's
 * `keyOnScreen` reads it. A draft answer is not a key seen, nor is an item no
 * longer listed.
 */
export function keyWasShown(screen: ScreenItem[], ref: string): boolean {
    const e = screen.find(x => x.ref === ref);
    return !!e && (typeof e.correct === 'boolean' || e.keyShown === true);
}

/** The items the assistant is told about, newest first. */
export function screenItems(): ScreenEntry[] {
    return useItemReports.getState().screen;
}

/** The report standing on a ref, for a surface that changes what it shows (a sitting leaves it out). */
export function useReportOn(ref: string | null): ItemReport | null {
    return useItemReports(s => (ref ? s.byRef[ref] ?? null : null));
}

/**
 * Put an item on the screen list while it is mounted, with what the screen
 * shows of the learner's answer. Called by the shared flag, so every surface
 * that has one tells the assistant what it shows.
 */
export function useScreenItem(
    ref: string | null,
    shown?: { answer?: string; correct?: boolean },
    { inStream = false, listed = false, hideKey }: { inStream?: boolean; listed?: boolean; hideKey?: boolean } = {},
) {
    const answer = shown?.answer;
    const correct = shown?.correct;
    useEffect(() => {
        if (!ref) return;
        // In a sitting the item that mounts is the one on screen. In a stream
        // every card mounts together; one becomes the learner's by an answer.
        // A row of a results list is listed and never the one on screen: the
        // whole sitting mounts at once, every row already answered.
        const current = !listed && (!inStream || !!answer || typeof correct === 'boolean');
        useItemReports.getState().showItem({
            ref,
            ...(answer ? { answer: answer.slice(0, 300) } : {}),
            ...(typeof correct === 'boolean' ? { correct } : {}),
            ...(typeof hideKey === 'boolean' ? { keyShown: !hideKey } : {}),
        }, current);
    }, [ref, answer, correct, inStream, listed, hideKey]);
    useEffect(() => {
        if (!ref) return;
        return () => useItemReports.getState().leaveItem(ref);
    }, [ref]);
}
