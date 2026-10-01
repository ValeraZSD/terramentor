/**
 * When a PAGE may act on Escape, and in what order.
 *
 * Escape already means something in a dozen places here — every dialog closes
 * on it, the model picker's list, an inline rename, a date editor, the search
 * palette — and those are registered as window listeners of their own, most of
 * them without claiming the key. A page that also listens has to stand back
 * whenever one of them is the thing the learner is in, or one press does two
 * things: the old atlas canvas closed its card AND left full screen, because a
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

/** What the atlas has open that Escape can take back, besides the card (which
 *  the surface itself answers for — `AtlasStage.dismissCard`). */
export interface AtlasEscapeState {
    selected: boolean;
    traced: boolean;
    fullscreen: boolean;
}

export type AtlasEscapeLayer = 'selection' | 'trace' | 'fullscreen';

/**
 * The next layer ONE press takes back, innermost first: the floating card (the
 * surface's), then the selected region, then the traced course — the view the
 * learner asked for, back to the clean map — and full screen last, because it
 * is the mode everything else happened in. Never two at once.
 */
export function atlasEscapeLayer(s: AtlasEscapeState): AtlasEscapeLayer | null {
    if (s.selected) return 'selection';
    if (s.traced) return 'trace';
    if (s.fullscreen) return 'fullscreen';
    return null;
}
