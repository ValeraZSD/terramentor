/**
 * One history entry per place: going to a page the learner already passed
 * on the way here steps BACK to it instead of stacking a second copy.
 *
 * Every move used to push. Settings, then a section, then the gear again,
 * then another section left Settings, section, Settings, section in the
 * history, and the phone's Back (or the browser's) walked through every one
 * of them before it left Settings. The same happened with the Today tab, a
 * course opened twice from a card, a "Set up AI" link pressed from Settings.
 *
 * The rule, for every `navigate(to)` the app makes (`useAppNavigate`, and the
 * store's injected navigate, both go through `placeNavigate`):
 *  - `to` is where the learner is now: the entry is replaced, never doubled.
 *  - `to` is an entry behind this one: the browser goes back to it, so Back
 *    from there continues from what came before it, the way a phone's
 *    bottom tabs and Android's "pop up to" work.
 *  - `to` is the top of the page the learner is on, from a part of it
 *    (`/settings` from `/settings#ai`): up a level, so it replaces.
 *  - anywhere else: a new entry, as before.
 * A move that carries router `state`, a number (`navigate(-1)`) or an
 * explicit `replace` is passed on unchanged.
 *
 * To step back to an entry the browser's own position is needed, counted in
 * browser entries, and the router's `idx` is not that: a dialog's Back entry
 * (`dialogHistory.ts`) shares its page's `idx`. So every entry is stamped
 * with an id of its own (`tmEntry` in `history.state`, beside the router's
 * fields and the dialog's mark) as it is pushed or replaced, and the ids are
 * kept in order here, with each entry's address and whether it is a page or
 * a dialog's mark. A traversal finds the current entry by its id. The list
 * survives a reload in `sessionStorage`, as the history itself does; an entry
 * that carries no id (one made before this, or an address typed into the
 * bar) starts the list over from it, so the rule never steps to an entry it
 * cannot vouch for.
 */
import { createPath, resolvePath, type NavigateFunction, type NavigateOptions, type To } from 'react-router-dom';
import { dialogDepthOf, dialogHistoryTraversing } from '../hooks/dialogHistory';

const ID = 'tmEntry';
const STORE = 'terramentor:history-entries';
/** Enough for any session; the oldest fall off the front. */
const MAX = 300;

type Entry = { id: string; href: string; page: boolean };

let entries: Entry[] = [];
let pos = -1;
let installed = false;
let seq = 0;

const here = () => window.location.pathname + window.location.search + window.location.hash;
const newId = () => `${Date.now().toString(36)}.${(seq++).toString(36)}.${Math.random().toString(36).slice(2, 7)}`;
function idOf(state: unknown): string | null {
    const v = (state as Record<string, unknown> | null)?.[ID];
    return typeof v === 'string' ? v : null;
}
function withId(state: unknown, id: string): Record<string, unknown> {
    return state && typeof state === 'object' ? { ...(state as Record<string, unknown>), [ID]: id } : { [ID]: id };
}

function save() {
    try { window.sessionStorage.setItem(STORE, JSON.stringify(entries)); } catch { /* private mode: the list lives for this page only */ }
}
function load(): Entry[] {
    try {
        const raw = JSON.parse(window.sessionStorage.getItem(STORE) ?? '[]');
        return Array.isArray(raw) ? raw.filter((e): e is Entry => e && typeof e.id === 'string' && typeof e.href === 'string') : [];
    } catch { return []; }
}
/** The browser keeps a bounded history (Chrome about 50 entries) and drops
 *  the oldest first; the list can never be longer than what it holds. */
function trim() {
    const cap = Math.min(MAX, window.history.length || MAX);
    if (entries.length <= cap) return;
    const drop = entries.length - cap;
    entries = entries.slice(drop);
    pos -= drop;
}

/** Where the browser is now, from the current entry's id; an entry with no
 *  id, or one the list does not hold, starts the list over from itself. */
function locate(stamp: (state: unknown) => void) {
    const state = window.history.state;
    let id = idOf(state);
    const at = id ? entries.findIndex(e => e.id === id) : -1;
    if (at >= 0) {
        pos = at;
        entries[at] = { id: id!, href: here(), page: dialogDepthOf(state) === 0 };
    } else {
        if (!id) { id = newId(); stamp(withId(state, id)); }
        entries = [{ id, href: here(), page: dialogDepthOf(state) === 0 }];
        pos = 0;
    }
    save();
}

/** Stamps every entry the app makes from now on. Runs once, on import. */
export function installPlaceHistory() {
    if (installed || typeof window === 'undefined') return;
    installed = true;
    const h = window.history;
    const push = h.pushState.bind(h);
    const replace = h.replaceState.bind(h);
    const stamp = (state: unknown) => replace(state, '');
    entries = load();
    locate(stamp);

    h.pushState = function pushState(state: unknown, unused: string, url?: string | URL | null) {
        const from = entries.findIndex(e => e.id === idOf(h.state));
        const id = newId();
        push(withId(state, id), unused, url);
        // Everything after the entry pushed from is gone, as the browser drops it.
        entries = from >= 0 ? entries.slice(0, from + 1) : [];
        entries.push({ id, href: here(), page: dialogDepthOf(state) === 0 });
        pos = entries.length - 1;
        trim();
        save();
    };
    h.replaceState = function replaceState(state: unknown, unused: string, url?: string | URL | null) {
        // The entry keeps its id: it is the same place in the list.
        const id = idOf(h.state) ?? newId();
        replace(withId(state, id), unused, url);
        locate(stamp);
    };
    window.addEventListener('popstate', () => {
        locate(stamp);
        // A step back of ours landed: a move asked for meanwhile runs now.
        if (pending) {
            clearTimeout(pending.timer);
            const next = pending.then;
            pending = null;
            next?.();
        }
    });
}

/** A step back under way: `history.go` answers a task later, and until then
 *  the address and the list still say where it started. */
let pending: { timer: ReturnType<typeof setTimeout>; then: (() => void) | null } | null = null;

function stepBack(delta: number, otherwise: () => void) {
    // The dialogs' own rule must not take this popstate for a Back, nor step
    // over a mark the closing dialog leaves meanwhile (`dialogHistory.ts`).
    dialogHistoryTraversing();
    // A traversal that never lands (the browser dropped that entry after
    // all) must not swallow the move: it is made as a new entry instead.
    const timer = setTimeout(() => {
        const next = pending?.then;
        pending = null;
        otherwise();
        next?.();
    }, 1000);
    pending = { timer, then: null };
    window.history.go(delta);
}

/** The nearest entry behind this one that is the page `href` (never a
 *  dialog's mark), or -1. */
function behind(href: string): number {
    for (let i = pos - 1; i >= 0; i--) if (entries[i].page && entries[i].href === href) return i;
    return -1;
}

/** `navigate` with the rule above. */
export function placeNavigate(navigate: NavigateFunction): NavigateFunction {
    const go = ((to: To | number, options?: NavigateOptions) => {
        if (typeof to === 'number') return navigate(to);
        // Asked again while a step back is landing (a double tap): once it has.
        if (pending) { pending.then = () => { go(to, options); }; return; }
        // A move that carries state means something beyond its address
        // (open the New course window, came from the list): passed on as asked.
        if (!installed || (options && 'state' in options)) return navigate(to, options);
        const target = createPath(resolvePath(to, window.location.pathname));
        if (target === here()) return navigate(to, { ...options, replace: true });
        // An explicit replace rewrites this entry, as asked; it never jumps.
        if (options?.replace) return navigate(to, options);
        const at = behind(target);
        if (at >= 0) { stepBack(at - pos, () => { navigate(to, options); }); return; }
        // A page's own top (`/settings`) from a part of it (`/settings#ai`)
        // is up, not forward: the gear pressed inside a Settings section
        // opened from a link elsewhere.
        const { pathname, hash } = resolvePath(to, window.location.pathname);
        if (!hash && pathname === window.location.pathname && window.location.hash) {
            return navigate(to, { ...options, replace: true });
        }
        return navigate(to, options);
    }) as NavigateFunction;
    return go;
}

/** For the gate: the list as it stands. */
export function placeHistorySnapshot() {
    return { pos, entries: entries.map(e => ({ ...e })) };
}

installPlaceHistory();
