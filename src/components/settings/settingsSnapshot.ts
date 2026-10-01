import { useEffect, useState } from 'react';
import { api } from '../../api';

/**
 * The settings table, read ONCE when Settings opens and handed to every
 * section that starts from it. Each section applies its own keys; none of them
 * reads the table again. `ok: false` is a failed read — the AI section still
 * marks itself loaded on it, as the one-component page did.
 */
export type SettingsSnapshot = { ok: true; values: Record<string, string> } | { ok: false };

export function useSettingsSnapshot(): SettingsSnapshot | null {
    const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null);
    useEffect(() => {
        api.getSettings()
            .then(values => setSnapshot({ ok: true, values }))
            .catch(e => {
                console.error('Failed to load AI settings:', e);
                setSnapshot({ ok: false });
            });
    }, []);
    return snapshot;
}
