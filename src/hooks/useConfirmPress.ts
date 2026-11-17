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
export function useConfirmPress<T>(resetKey: unknown) {
    const confirm = useStore(s => s.a11y.confirmAnswers);
    const [armed, setArmed] = useState<T | null>(null);
    // The newest selection, for a key handler that closed over an older render.
    const armedRef = useRef<T | null>(null);
    armedRef.current = armed;
    useEffect(() => { setArmed(null); armedRef.current = null; }, [resetKey, confirm]);

    const press = (value: T, commit: () => void) => {
        if (!confirm || armedRef.current === value) {
            setArmed(null);
            armedRef.current = null;
            commit();
            return;
        }
        armedRef.current = value;
        setArmed(value);
    };
    return { armed: confirm ? armed : null, press, confirm };
}
