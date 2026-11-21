import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { canHideClock, clockHidden } from './mockClock';

/**
 * A length of exam time as people say it: "3 h", "2 h 51", "45 min".
 * Never "2:51", which reads as a time of day.
 */
export function useDuration() {
    const { t } = useTranslation();
    return useCallback((seconds: number) => {
        const minutes = Math.max(0, Math.floor(seconds / 60));
        const h = Math.floor(minutes / 60);
        const m = minutes % 60;
        if (h === 0) return t("{{m}} min", { m });
        if (m === 0) return t("{{h}} h", { h });
        return t("{{h}} h {{m}}", { h, m: String(m).padStart(2, '0') });
    }, [t]);
}

export { REVEAL_AT, mockClockSeconds } from './mockClock';

/**
 * "Hide the clock", kept per mock in this tab: a reload or a phone turned
 * sideways keeps it hidden. With five minutes left it shows again by itself
 * and cannot be hidden, and the wish is dropped, so time taken off the clock
 * later never hides it again. Storage that refuses is no loss.
 */
export function useHiddenClock(sittingId: number, secondsLeft: number) {
    const key = `mock-clock-hidden:${sittingId}`;
    const [wanted, setWanted] = useState(() => {
        try { return sessionStorage.getItem(key) === '1'; } catch { return false; }
    });
    const setHidden = useCallback((hide: boolean) => {
        setWanted(hide);
        try {
            if (hide) sessionStorage.setItem(key, '1');
            else sessionStorage.removeItem(key);
        } catch { /* private mode: this tab only */ }
    }, [key]);
    const canHide = canHideClock(secondsLeft);
    useEffect(() => { if (wanted && !canHide) setHidden(false); }, [wanted, canHide, setHidden]);
    return { hidden: clockHidden(wanted, secondsLeft), canHide, setHidden };
}
