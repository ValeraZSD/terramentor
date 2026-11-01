// Reports the client knows about, by ref, and the items on the learner's screen.
//
// One store behind every flag: a report filed on the feed shows as reported in
// the assistant's proposal and the other way round, and an Undo anywhere
// clears it everywhere. The screen list is what the assistant drawer sends with
// a turn (`ScreenItem`: a ref and what the screen showed); the server reads the
// items themselves.
import { useEffect } from 'react';
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

async function ask(refs: string[]): Promise<void> {
    for (let i = 0; i < refs.length; i += REFS_PER_REQUEST) {
        const part = refs.slice(i, i + REFS_PER_REQUEST);
        for (const r of part) asking.add(r);
        try {
            const { reports } = await api.listItemReports({ refs: part });
            useItemReports.setState(s => {
                const byRef = { ...s.byRef };
                for (const r of part) byRef[r] = null;
                for (const r of reports) byRef[r.ref] = r;
                return { byRef };
            });
        } catch { /* the flag works without knowing: a second report returns the standing one */ }
        finally { for (const r of part) asking.delete(r); }
    }
}

export const useItemReports = create<ItemReportState>((set, get) => ({
    byRef: {},
    screen: [],
    setReport: (ref, report) => set(s => ({ byRef: { ...s.byRef, [ref]: report && !report.undoneAt ? report : null } })),
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
