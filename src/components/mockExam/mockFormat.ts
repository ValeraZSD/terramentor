import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

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
