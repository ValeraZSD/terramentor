import { useEffect, useState } from 'react';

/**
 * Subscribe to a CSS media query and re-render when it changes.
 * SSR-safe (returns `false` until mounted in the browser).
 */
export function useMediaQuery(query: string): boolean {
    const [matches, setMatches] = useState(() =>
        typeof window !== 'undefined' && typeof window.matchMedia === 'function'
            ? window.matchMedia(query).matches
            : false
    );

    useEffect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
        const mql = window.matchMedia(query);
        const onChange = () => setMatches(mql.matches);
        onChange();
        mql.addEventListener('change', onChange);
        return () => mql.removeEventListener('change', onChange);
    }, [query]);

    return matches;
}

/** True on phone-sized viewports (below the Tailwind `md` breakpoint). */
export function useIsMobile(): boolean {
    return useMediaQuery('(max-width: 767px)');
}
