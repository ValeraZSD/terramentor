import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';

/**
 * Confirm before grading (Settings → Accessibility). With it on, the first
 * press of an answer or a rating SELECTS it and the second press on the same
 * one commits; a press on another selects that one instead. For a hand that
 * shakes, a stray tap then costs nothing. Off (the default), a press commits
 * at once, exactly as before.
 *
 * `resetKey` is what is being answered (the card and its side, the
 * question): when it changes, nothing is selected any more.
 */
/** A second press sooner than this after the first is the same press. */
export const DOUBLE_PRESS_MS = 400;

export function useConfirmPress<T>(resetKey: unknown) {
    const confirm = useStore(s => s.a11y.confirmAnswers);
    const [armed, setArmed] = useState<T | null>(null);
    // The newest selection, for a key handler that closed over an older render.
    const armedRef = useRef<T | null>(null);
    armedRef.current = armed;
    const armedAt = useRef(0);
    useEffect(() => { setArmed(null); armedRef.current = null; }, [resetKey, confirm]);

    const press = (value: T, commit: () => void) => {
        // A hand that shakes often lands one click twice, a few milliseconds
        // apart: that second press is the same stray tap, not a decision.
        if (confirm && armedRef.current === value && Date.now() - armedAt.current < DOUBLE_PRESS_MS) return;
        if (!confirm || armedRef.current === value) {
            setArmed(null);
            armedRef.current = null;
            commit();
            return;
        }
        armedRef.current = value;
        armedAt.current = Date.now();
        setArmed(value);
    };
    return { armed: confirm ? armed : null, press, confirm };
}
