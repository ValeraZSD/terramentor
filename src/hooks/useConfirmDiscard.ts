import { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store';

/**
 * "Discard your changes?" before a form with unsaved work closes, whichever way
 * it was closed: its ✕ or Cancel, Escape, a tap outside, the system's Back.
 * One wording and one look for every form that asks (CLAUDE.md, "Saved means
 * written": a changed edit asks before Escape/Cancel).
 *
 * Resolves true when the learner chose to discard. A second ask while one is
 * showing resolves false at once, so two ways out pressed together ask once.
 */
export function useConfirmDiscard(): (message: string) => Promise<boolean> {
    const { t } = useTranslation();
    const showConfirm = useStore(s => s.showConfirm);
    const asking = useRef(false);
    return useCallback(async (message: string) => {
        if (asking.current) return false;
        asking.current = true;
        try {
            return await showConfirm({
                title: t("Discard your changes?"),
                message,
                confirmLabel: t("Discard"),
                cancelLabel: t("Keep editing"),
                variant: 'warning',
            });
        } finally {
            asking.current = false;
        }
    }, [showConfirm, t]);
}
