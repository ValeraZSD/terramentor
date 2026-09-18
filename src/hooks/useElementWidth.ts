import { useLayoutEffect, useState, type RefObject } from 'react';

/**
 * The element's own width in CSS pixels, tracked as it changes.
 *
 * A figure made of one mark per item cannot decide how to draw itself from a
 * breakpoint: the same stage row is ~600px wide on a desktop, ~300px on a phone
 * and narrower again with the detail panel open beside it, and the number of
 * marks comes from the data. So the decision — squares or a bar, and how much
 * air between the squares — is arithmetic over the real width, not a guess
 * baked into a class name.
 *
 * Measured in `useLayoutEffect` so the first paint already has the right
 * answer; the observer then only handles resizes, rotation and the panel
 * opening. Width 0 means "not measured yet" and callers should render the
 * layout-independent fallback.
 */
export function useElementWidth(ref: RefObject<HTMLElement>): number {
    const [width, setWidth] = useState(0);

    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const measure = () => setWidth(el.clientWidth);
        measure();

        // Both, because neither alone is enough. `resize` misses the cases that
        // matter most here — a panel opening beside the element, a section
        // expanding — while ResizeObserver's callback is delivered at the end
        // of a frame, so a document that is not being painted never gets one:
        // measured in the preview browser, a fresh observer on a 716px element
        // reported nothing at all in 600ms. Width 0 is a legitimate answer
        // meanwhile, which is why callers must have a fallback that needs no
        // measurement.
        window.addEventListener('resize', measure);
        const ro = typeof ResizeObserver !== 'undefined'
            ? new ResizeObserver(entries => {
                for (const e of entries) setWidth(e.contentRect.width);
            })
            : null;
        ro?.observe(el);
        return () => {
            window.removeEventListener('resize', measure);
            ro?.disconnect();
        };
    }, [ref]);

    return width;
}
