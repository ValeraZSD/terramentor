import { useMemo, useSyncExternalStore, type CSSProperties } from 'react';
import { dropFlashDelay, dropFlashStart, subscribeDropFlash } from '../utils/dropFlash';

/**
 * The class and style that flash a dropped item where it landed
 * (`utils/dropFlash.ts`), or null while it is not flashing. Spread onto the
 * element whose rounded edge the ring traces.
 */
export function useDropFlash(key: string): { className: string; style: CSSProperties } | null {
    const start = useSyncExternalStore(subscribeDropFlash, () => dropFlashStart(key));
    // Read once per start, not per render: a delay recomputed on a hover
    // re-render would move a running animation forward.
    const delay = useMemo(() => (start == null ? 0 : dropFlashDelay(start)), [start]);
    if (start == null) return null;
    return {
        className: 'drop-flash',
        style: { '--drop-flash-delay': `${delay}ms` } as CSSProperties,
    };
}
