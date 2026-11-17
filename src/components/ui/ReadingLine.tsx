import { useRef, useState, type ReactNode } from 'react';
import { useStore } from '../../store';

/**
 * A reading line over long lesson text (Settings → Accessibility): a tinted
 * band behind the line under the pointer, so the eye keeps its place in a
 * paragraph. A tap moves it on a touch screen. Drawn BEHIND the words (an
 * isolated stacking context, the band at z -1), so it never covers or dims
 * what is being read, and it takes no clicks.
 *
 * Off (the default), this renders its children and nothing else.
 */
export default function ReadingLine({ children }: { children: ReactNode }) {
    const on = useStore(s => s.a11y.readingLine);
    const box = useRef<HTMLDivElement>(null);
    const [band, setBand] = useState<{ top: number; height: number } | null>(null);

    if (!on) return <>{children}</>;

    const follow = (e: React.PointerEvent) => {
        const el = box.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        // One line of whatever is under the pointer: a heading's line is
        // taller than a paragraph's.
        const under = e.target instanceof Element ? e.target : el;
        const lh = parseFloat(getComputedStyle(under).lineHeight);
        const height = Number.isFinite(lh) && lh > 0 ? lh : parseFloat(getComputedStyle(el).fontSize) * 1.75;
        const y = e.clientY - rect.top;
        setBand({ top: Math.max(0, Math.min(rect.height - height, y - height / 2)), height });
    };

    return (
        <div
            ref={box}
            className="relative isolate"
            data-reading-line
            onPointerMove={e => { if (e.pointerType === 'mouse' || e.pointerType === 'pen') follow(e); }}
            onPointerDown={follow}
        >
            {band && (
                <div
                    aria-hidden="true"
                    className="pointer-events-none absolute -inset-x-2 -z-10 rounded-md bg-accent/10 border-y-2 border-accent/50"
                    style={{ top: band.top, height: band.height }}
                />
            )}
            {children}
        </div>
    );
}
