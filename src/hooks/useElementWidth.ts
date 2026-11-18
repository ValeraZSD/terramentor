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
 *
 * The width is the CONTENT box: the padding is taken off. The observer's
 * `contentRect` is that quantity, and `clientWidth` alone is the padding box, so
 * the first measure and a window resize used to disagree with an observer
 * callback by the element's horizontal padding. A caller laying marks out inside
 * a padded element gets the room it really has; the height hook is the same.
 */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
    return useElementSide(ref, 'width');
}

/** The same for the element's height: a panel deciding whether its list still
 *  has room under a fixed header. */
export function useElementHeight(ref: RefObject<HTMLElement | null>): number {
    return useElementSide(ref, 'height');
}

function useElementSide(ref: RefObject<HTMLElement | null>, side: 'width' | 'height'): number {
    const [size, setSize] = useState(0);

    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        // The content box, the same quantity the observer reports
        // (`contentRect`): `clientWidth` alone includes the padding, so a padded
        // element read 32px wider after a window resize than after an observer
        // callback, and a threshold flipped on the wrong side.
        const measure = () => {
            const cs = window.getComputedStyle(el);
            const pad = side === 'width'
                ? (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0)
                : (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
            setSize(Math.max(0, (side === 'width' ? el.clientWidth : el.clientHeight) - pad));
        };
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
                for (const e of entries) setSize(side === 'width' ? e.contentRect.width : e.contentRect.height);
            })
            : null;
        ro?.observe(el);
        return () => {
            window.removeEventListener('resize', measure);
            ro?.disconnect();
        };
    }, [ref, side]);

    return size;
}
