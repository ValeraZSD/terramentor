import { useEffect, useRef, useState } from 'react';
import { Check, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { useStore } from '../store';
import type { SettingChange, SettingKey } from '../utils/assistantSettings';
import { useTranslation } from 'react-i18next';

/**
 * "I changed it" — and the way back.
 *
 * The assistant proposes a validated key/value pair (see assistantSettings.ts);
 * this applies it and is the record that it happened. Both halves earn their
 * place:
 *
 * APPLIED, not offered. Everything on the whitelist is visible the instant it
 * lands — the page is already the new theme by the time the sentence is read —
 * so a confirm step would ask the learner to approve a change they can simply
 * SEE. That is friction with nothing on the other side of it.
 *
 * WITH AN UNDO, not a toast. The change was made on a model's reading of a
 * sentence, so a wrong one is a normal outcome rather than an exception, and
 * the way back has to be next to the thing that caused it and has to still be
 * there a minute later. That rules out a toast, which expires, and it rules out
 * "go to Settings", which is what the assistant could already say.
 *
 * Applied exactly ONCE per message, guarded by a ref rather than by the value
 * having changed: re-reading yesterday's conversation must not re-apply
 * yesterday's changes, and a learner who undid one and scrolled away must not
 * find it re-applied when they scroll back.
 */
export default function SettingChangeChips({ changes, messageKey, record = false }: {
    changes: SettingChange[];
    /** Stable per message; the apply-once guard is keyed on it. */
    messageKey: string;
    /**
     * A re-read of an older turn: state what it did, change nothing, offer no
     * Undo. Both halves matter. Re-applying would make scrolling back through a
     * conversation restyle the app, and the guard that prevents it is a ref —
     * which is empty again after a reload. But rendering NOTHING was its own
     * bug: the answer says "switching the interface to Dutch now:" and a
     * reopened conversation showed that sentence with nothing after it, so a
     * change that had actually happened read as one that had failed. Undo is
     * left off because the value may have moved on since, and a button offering
     * to restore what was current an hour ago is a worse lie than no button.
     */
    record?: boolean;
}) {
    const { t } = useTranslation();
    const setTheme = useStore(s => s.setTheme);
    const setAccentColor = useStore(s => s.setAccentColor);
    const setUiScale = useStore(s => s.setUiScale);
    const setWeekStartDay = useStore(s => s.setWeekStartDay);
    const setUiLanguage = useStore(s => s.setUiLanguage);
    const setNumberFormat = useStore(s => s.setNumberFormat);
    const addToast = useStore(s => s.addToast);

    // What each setting was before this message touched it, so Undo restores a
    // real previous value rather than a default someone assumed.
    const [previous, setPrevious] = useState<Partial<Record<SettingKey, string | number>> | null>(null);
    const [undone, setUndone] = useState(false);
    const appliedRef = useRef<string | null>(null);

    useEffect(() => {
        if (record || !changes.length || appliedRef.current === messageKey) return;
        appliedRef.current = messageKey;

        const s = useStore.getState();
        const before: Partial<Record<SettingKey, string | number>> = {};
        for (const c of changes) {
            if (c.key === 'theme') before.theme = s.theme;
            else if (c.key === 'accent_color') before.accent_color = s.accentColor;
            else if (c.key === 'ui_scale') before.ui_scale = s.uiScale;
            else if (c.key === 'week_start_day') before.week_start_day = s.weekStartDay;
            else if (c.key === 'ui_language') before.ui_language = s.uiLanguage;
            else if (c.key === 'number_format') before.number_format = s.numberFormat;
        }
        setPrevious(before);
        void apply(changes.map(c => [c.key, c.value] as const));
        // `changes` is derived from the message text, which is stable for a
        // given messageKey — keying the guard on messageKey is what makes this
        // safe against the re-renders a streaming panel does constantly.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [messageKey, record]);

    const apply = async (pairs: ReadonlyArray<readonly [SettingKey, string | number]>) => {
        try {
            for (const [key, value] of pairs) {
                if (key === 'theme') await setTheme(value as never);
                else if (key === 'accent_color') await setAccentColor(String(value));
                else if (key === 'ui_scale') await setUiScale(Number(value));
                else if (key === 'week_start_day') await setWeekStartDay(Number(value) as never);
                else if (key === 'ui_language') await setUiLanguage(String(value));
                else if (key === 'number_format') await setNumberFormat(String(value));
            }
        } catch (e) {
            addToast('error', t("Could not change that setting"), e instanceof Error ? e.message : String(e));
        }
    };

    if (!changes.length) return null;

    const undo = async () => {
        if (!previous) return;
        await apply(Object.entries(previous) as ReadonlyArray<readonly [SettingKey, string | number]>);
        setUndone(true);
    };

    return (
        <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="inline-flex items-center gap-1.5 text-slate-500 dark:text-slate-400">
                <SlidersHorizontal className="w-3.5 h-3.5" />
                {undone ? t("Reverted") : t("Changed")}
            </span>
            {changes.map(c => (
                <span
                    key={c.key}
                    className={`inline-flex items-center gap-1 px-2 py-1 rounded-full font-medium ${undone
                        ? 'bg-slate-100 dark:bg-slate-700 text-slate-400 dark:text-slate-500 line-through'
                        : 'bg-accent/10 text-accent-fg'}`}
                >
                    {!undone && <Check className="w-3 h-3" />}
                    {c.label}
                </span>
            ))}
            {!undone && !record && (
                <button
                    type="button"
                    onClick={undo}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-full font-medium text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition"
                >
                    <RotateCcw className="w-3 h-3" />
                    {t("Undo")}
                </button>
            )}
        </div>
    );
}
