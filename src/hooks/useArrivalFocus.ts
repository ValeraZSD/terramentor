import { useEffect, useRef, useState } from 'react';
import { focusIsLost } from '../utils/a11y';

/**
 * Something that takes the place of the control that had focus (a verdict
 * replacing Check answer): focus moves to it, and `arrived` says it may be
 * read out. Only when it ARRIVES while mounted. One already there when the
 * component mounts (a reload, a card scrolled back into the feed) was said
 * when it was given, and focus stays wherever the learner left it.
 *
 * `key` names what is shown ('' = nothing); a change of key is an arrival.
 */
export function useArrivalFocus<T extends HTMLElement>(key: string) {
    const ref = useRef<T>(null);
    const last = useRef(key);
    const [arrived, setArrived] = useState(false);
    useEffect(() => {
        const before = last.current;
        last.current = key;
        if (!key) { setArrived(false); return; }
        if (key === before) return;
        setArrived(true);
        if (focusIsLost(document.activeElement)) ref.current?.focus({ preventScroll: true });
    }, [key]);
    return { ref, arrived };
}
