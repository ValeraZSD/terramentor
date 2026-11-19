import { useEffect, useState } from 'react';
import { todayStr } from '../utils/tree';

/**
 * The device's date (`todayStr()`), re-read just after the next local midnight
 * and whenever the page is shown again, since a sleeping laptop runs no timer.
 * A screen that marks today calls it so a view left open overnight renders
 * the new day by itself, without the learner touching it.
 */
export function useToday(): string {
    const [today, setToday] = useState(() => todayStr());
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const arm = () => {
            const now = new Date();
            const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
            // A second past midnight, so the timer never lands a hair early.
            timer = setTimeout(() => { setToday(todayStr()); arm(); }, next.getTime() - now.getTime() + 1000);
        };
        arm();
        const onVisible = () => { if (document.visibilityState === 'visible') setToday(todayStr()); };
        document.addEventListener('visibilitychange', onVisible);
        return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
    }, []);
    return today;
}
