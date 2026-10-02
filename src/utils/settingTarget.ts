import { scrollIntoViewWithin } from './scrollWithin';

/**
 * A link INTO Settings: `/settings#<tab>/<target>`.
 *
 * `#ai` lands on a tab; `#ai/embeddings` also brings one setting to the top of
 * it and flashes it. The atlas's empty state said "Set up an embedding model"
 * and opened Settings on whatever tab was last open — the field it meant was
 * three screens down the AI tab, inside a closed row, and nothing on the way
 * said where. A reader who has to hunt for the control a button promised has
 * been sent to the wrong place.
 *
 * The element is found by id, `setting-<target>`, so a new destination is an
 * id on the row and nothing else.
 */
export function parseSettingsHash(hash: string): { tab: string; target: string | null } {
    const [tab = '', target = ''] = hash.replace(/^#/, '').split('/');
    return { tab, target: target || null };
}

export const settingTargetId = (target: string) => `setting-${target}`;

/** How long the flash lasts — matches `.setting-flash` in index.css. */
const FLASH_MS = 1400;

/**
 * Open, scroll to and flash one setting inside `scroller`.
 *
 * Every closed `<details>` holding it is opened first (the rows of Model jobs
 * are disclosures), because a target scrolled to while its body is folded
 * away lands the reader on a summary line and a chevron. Scrolling is
 * instant, not smooth: the flash is what carries the eye, and a smooth scroll
 * on a page that is still filling in arrives somewhere the content has since
 * moved from. Focus goes to the row's own control without moving anything, so
 * the next Tab continues from where the reader was sent.
 *
 * Returns false when there is no such element — a stale link, or a section
 * this build does not have — and then nothing moves.
 */
export function revealSetting(target: string, scroller: HTMLElement | null): boolean {
    const el = document.getElementById(settingTargetId(target));
    if (!el || !scroller) return false;
    for (let node: HTMLElement | null = el; node && node !== scroller; node = node.parentElement) {
        if (node instanceof HTMLDetailsElement && !node.open) node.open = true;
    }
    const place = () => scrollIntoViewWithin(el, { boundary: scroller, block: 'start', padding: 16 });
    place();
    // The tab may still be filling in (its settings arrive after it mounts), so
    // the row can move under the reader in the first moments. Re-place it once
    // — unless the reader has scrolled in between, which is theirs to keep.
    const settled = scroller.scrollTop;
    window.setTimeout(() => { if (Math.abs(scroller.scrollTop - settled) < 2) place(); }, 350);

    const focusable = el.querySelector<HTMLElement>('summary, button, input, select, textarea, [tabindex]');
    focusable?.focus({ preventScroll: true });

    el.classList.remove('setting-flash');
    // Restart the animation if the same link is followed twice in a row.
    void el.offsetWidth;
    el.classList.add('setting-flash');
    window.setTimeout(() => el.classList.remove('setting-flash'), FLASH_MS + 100);
    return true;
}
