/**
 * When a PAGE may act on Escape, and in what order.
 *
 * Escape already means something in a dozen places here — every dialog closes
 * on it, the model picker's list, an inline rename, a date editor, the search
 * palette — and those are registered as window listeners of their own, most of
 * them without claiming the key. A page that also listens has to stand back
 * whenever one of them is the thing the learner is in, or one press does two
 * things: an atlas canvas would close its card AND leave full screen because a
 * second window listener took the same key.
 *
 * So a page's Escape runs only when nothing else can be its owner:
 *   - nobody claimed it already (`defaultPrevented`);
 *   - it is not text being typed — Escape in a field is the field's (clearing
 *     it, cancelling an IME composition), and a page that acted too would throw
 *     away what the learner was doing to something they could not see;
 *   - no modal dialog is open: it closes on the same press, and the page is
 *     underneath it;
 *   - focus is in the page, or nowhere. The docked assistant is a column of the
 *     app beside the page, and a press made there is not about the map.
 */

/** A key press that belongs to text the learner is typing. A closed `<select>`
 *  is NOT one: it is where focus sits right after picking a course, and Escape
 *  there is the whole point of the key. */
export function isTextEntry(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el || typeof el.tagName !== 'string') return false;
    if (el.isContentEditable) return true;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName !== 'INPUT') return false;
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    return !['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'color', 'file', 'image'].includes(type);
}

/** Minimal shape of the event, so the rule can be exercised without a browser. */
export interface EscapeLike {
    key: string;
    defaultPrevented: boolean;
    isComposing?: boolean;
    target: EventTarget | null;
}

/**
 * May this page act on this Escape? `root` is the page's own element; a press
 * whose target is outside it (and is not the document body, where focus rests
 * when nothing holds it) belongs to someone else.
 */
export function pageMayTakeEscape(e: EscapeLike, root: Element | null, doc: Document = document): boolean {
    if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return false;
    if (isTextEntry(e.target)) return false;
    if (doc.querySelector('[role="dialog"][aria-modal="true"]')) return false;
    const t = e.target as Node | null;
    if (!t || t === doc.body || t === doc.documentElement || t === doc) return true;
    return !!root && root.contains(t);
}

/** Minimal shape of a letter press, for the app-wide shortcuts. */
export interface ShortcutLike {
    defaultPrevented: boolean;
    isComposing?: boolean;
    metaKey?: boolean;
    ctrlKey?: boolean;
    altKey?: boolean;
    shiftKey?: boolean;
    target: EventTarget | null;
}

/**
 * May an app-wide letter key (`a` the assistant) act on this
 * press? Not while typing (a closed `<select>` counts: a letter picks an option
 * there), not mid-composition, not with a modifier, and not while something
 * else owns the keyboard: a modal dialog, or a surface that marks itself
 * `data-owns-keyboard` (the review session, whose Space and 1-4 stop the moment
 * focus leaves it). A dialog that focuses a button first otherwise lost the
 * name being typed into it to the assistant, which then sent it.
 */
export function appMayTakeShortcut(e: ShortcutLike, doc: Document = document): boolean {
    if (e.defaultPrevented || e.isComposing) return false;
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
    const el = e.target as HTMLElement | null;
    // A dropdown (`ui/Select`, a combobox button) takes letters as type-ahead too.
    if (isTextEntry(el) || el?.tagName === 'SELECT' || el?.getAttribute?.('role') === 'combobox') return false;
    return !doc.querySelector('[role="dialog"][aria-modal="true"], [data-owns-keyboard]');
}

/**
 * The letter a shortcut press stands for, on any keyboard layout, or null.
 *
 * `e.key` is what the layout types, which is what a Dvorak or AZERTY user
 * expects their `c` to be. A layout with no Latin letters types something else
 * on every key: on a Russian keyboard the key printed "C" and "С" gives `с`,
 * so a shortcut matched on `e.key` alone never fires there. Then the PHYSICAL
 * key (`e.code`, `KeyC`) is the letter, which is also the Latin one printed on
 * that key. Caps Lock reports an upper-case letter; it reads the same.
 * Only a letter of ANOTHER SCRIPT falls back to the physical key: Dvorak types
 * `,` on the key QWERTY prints W, and that comma is not a W to its user; on
 * US-International a dead key then C types `ç`, which is not a C press either.
 */
export function shortcutLetter(e: { key: string; code?: string }): string | null {
    if (/^[a-z]$/i.test(e.key)) return e.key.toLowerCase();
    if (!/^\p{L}$/u.test(e.key) || /^\p{Script=Latin}$/u.test(e.key)) return null;
    const physical = /^Key([A-Z])$/.exec(e.code ?? '');
    return physical ? physical[1].toLowerCase() : null;
}

/** What the atlas has open that Escape can take back, besides the card (which
 *  the surface itself answers for — `AtlasStage.dismissCard`). */
export interface AtlasEscapeState {
    selected: boolean;
    /** The phone's index sheet is pulled open over the map. */
    sheet?: boolean;
    traced: boolean;
    fullscreen: boolean;
}

export type AtlasEscapeLayer = 'selection' | 'sheet' | 'trace' | 'fullscreen';

/**
 * Escape pressed IN the atlas search field, which `pageMayTakeEscape` rightly
 * leaves to the field. The field answers it itself: text in it is cleared
 * first (what Escape does in a search box), and an empty field on a phone
 * whose sheet the field opened folds the sheet, since focusing the field is
 * the usual way it opens and Escape is the usual way back. Otherwise nothing,
 * and the key is not claimed.
 */
export function searchFieldEscape(s: {
    key: string; isComposing?: boolean; query: string; sheet: boolean;
}): 'clear' | 'fold' | null {
    if (s.key !== 'Escape' || s.isComposing) return null;
    if (s.query) return 'clear';
    if (s.sheet) return 'fold';
    return null;
}

/**
 * The next layer ONE press takes back, innermost first: the floating card (the
 * surface's), then the selected region, then the open sheet (the map back to
 * full height), then the traced course — the view the learner asked for, back
 * to the clean map — and full screen last, because it is the mode everything
 * else happened in. Never two at once.
 */
export function atlasEscapeLayer(s: AtlasEscapeState): AtlasEscapeLayer | null {
    if (s.selected) return 'selection';
    if (s.sheet) return 'sheet';
    if (s.traced) return 'trace';
    if (s.fullscreen) return 'fullscreen';
    return null;
}
