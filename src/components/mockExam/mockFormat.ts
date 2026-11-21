import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DrillTimeScale } from '../drills/parseDrill';

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

/** Seconds left at which a hidden clock shows again, the way an invigilator calls the last five minutes. */
export const REVEAL_AT = 300;

/**
 * "Hide the clock", kept per mock in this tab: a reload or a phone turned
 * sideways keeps it hidden. With five minutes left it shows again by itself
 * and cannot be hidden. Storage that refuses is no loss.
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
    const canHide = secondsLeft > REVEAL_AT;
    return { hidden: wanted && canHide, canHide, setHidden };
}

/**
 * The clock a mock will get: its own time stretched by the learner's Time
 * limits setting, or 0 (no clock) when that is Off. The server sets the real
 * clock by the same rule when the mock starts (server/mockExams.js clockSeconds).
 */
export function mockClockSeconds(seconds: number, scale: DrillTimeScale): number {
    return scale === 'off' ? 0 : seconds * Number(scale);
}
