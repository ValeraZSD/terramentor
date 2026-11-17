import { useRef, useState, type ReactNode } from 'react';
import { useStore } from '../../store';

/** The box of the text line at a point: the caret there is as tall as the
 *  line's text, so its middle is the line's middle. Null off text. */
function caretRect(x: number, y: number): DOMRect | null {
    let range: Range | null = null;
    if (typeof document.caretPositionFromPoint === 'function') {
        const at = document.caretPositionFromPoint(x, y);
        if (at) { range = document.createRange(); range.setStart(at.offsetNode, at.offset); }
    } else if (typeof document.caretRangeFromPoint === 'function') {
        range = document.caretRangeFromPoint(x, y);
    }
    if (!range || range.startContainer.nodeType !== Node.TEXT_NODE) return null;
    const r = range.getClientRects()[0] ?? range.getBoundingClientRect();
    return r && r.height > 0 ? r : null;
}

/**
 * A reading line over long lesson text (Settings → Accessibility): a tinted
 * band behind the line under the pointer, so the eye keeps its place in a
 * paragraph. A tap moves it on a touch screen. Drawn BEHIND the words (an
 * isolated stacking context, the band at z -1), so it never covers or dims
 * what is being read, and it takes no clicks.
 *
 * Off (the default), this is a plain block around its children.
 */
export default function ReadingLine({ children }: { children: ReactNode }) {
    const on = useStore(s => s.a11y.readingLine);
    const box = useRef<HTMLDivElement>(null);
    const [band, setBand] = useState<{ top: number; height: number } | null>(null);

    const follow = (e: React.PointerEvent) => {
        const el = box.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        // One line of whatever is under the pointer: a heading's line is
        // taller than a paragraph's.
        const under = e.target instanceof Element ? e.target : el;
        const lh = parseFloat(getComputedStyle(under).lineHeight);
        const height = Number.isFinite(lh) && lh > 0 ? lh : parseFloat(getComputedStyle(el).fontSize) * 1.75;
        // Centre the band on the LINE under the pointer, not on the pointer:
        // centred on the pointer it straddled two lines, and its edge ran
        // through the words like a strike-through.
        const caret = caretRect(e.clientX, e.clientY);
        const y = caret && caret.top >= rect.top && caret.bottom <= rect.bottom
            ? caret.top + caret.height / 2 - rect.top
            : e.clientY - rect.top;
        setBand({ top: Math.max(0, Math.min(rect.height - height, y - height / 2)), height });
    };

    // One element whether on or off, with the children in the same place:
    // swapping it for a fragment when the setting flips would remount the
    // whole lesson under it (drills, visuals and sketch frames reload and
    // lose their state).
    return (
        <div
            ref={box}
            className={on ? 'relative isolate' : undefined}
            data-reading-line={on || undefined}
            onPointerMove={on ? e => { if (e.pointerType === 'mouse' || e.pointerType === 'pen') follow(e); } : undefined}
            onPointerDown={on ? follow : undefined}
        >
            {on && band && (
                <div
                    aria-hidden="true"
                    className="pointer-events-none absolute -inset-x-2 -z-10 rounded-md bg-accent/10 border-y border-accent/40"
                    style={{ top: band.top, height: band.height }}
                />
            )}
            {children}
        </div>
    );
}
