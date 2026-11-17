import { useEffect, useState } from 'react';
import { Loader2, Target } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api';
import { useStore } from '../../store';
import type { RetentionForecast } from '../../types';
import { REQUEST_RETENTION, RETENTION_CHOICES } from '../../utils/srs';
import { Button } from '../ui/Button';
import Radio from '../ui/Radio';
import { fmt } from './deckPalette';

const pct = (r: number) => `${Math.round(r * 100)}%`;
/** Reviews a day as said: whole numbers, except under one, where a whole number
 *  reads "about 0" for a course that will still ask for something. */
const perDayShown = (n: number) => (n > 0 && n < 1 ? Math.round(n * 10) / 10 : Math.round(n));

/**
 * The course's recall target, at rest: one quiet button beside the daily
 * new-card allowance, because the two are the course's whole say in how much
 * card work a day it asks for.
 */
export function RetentionButton({ value, onEdit, focusOnMount = false }: {
    value: number;
    onEdit: () => void;
    /** Back from the editor: focus returns here, not to the page. */
    focusOnMount?: boolean;
}) {
    const { t } = useTranslation();
    return (
        <Button
            variant="quiet"
            size="sm"
            onClick={onEdit}
            autoFocus={focusOnMount}
            icon={<Target className="h-3.5 w-3.5" aria-hidden="true" />}
        >
            {t("Recall target {{pct}}", { pct: pct(value) })}
        </Button>
    );
}

/**
 * Pick the recall target with its cost in sight: each choice says how many
 * reviews a day it would ask of THIS course over the next month (the
 * scheduler's own simulation, server/decks.js `retentionForecast`), before
 * anything is saved. 90% is the app's standard and stores nothing.
 */
export function RetentionEditor({ projectId, value, onDone }: {
    projectId: number;
    value: number;
    /** Closed, `saved` when a new target was written. */
    onDone: (saved: boolean) => void;
}) {
    const { t } = useTranslation();
    const addToast = useStore(s => s.addToast);
    const loadProjects = useStore(s => s.loadProjects);
    const [choice, setChoice] = useState(value);
    const [forecast, setForecast] = useState<RetentionForecast | null>(null);
    const [failed, setFailed] = useState(false);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        let live = true;
        api.getRetentionForecast(projectId)
            .then(f => { if (live) setForecast(f); })
            .catch(() => { if (live) setFailed(true); });
        return () => { live = false; };
    }, [projectId]);

    // A target set elsewhere (another device, the assistant) stays offered.
    const options = [...new Set<number>([...RETENTION_CHOICES, value])].sort((a, b) => a - b);
    const perDay = (r: number) => forecast?.choices.find(c => Math.abs(c.retention - r) < 1e-9)?.perDay;

    const save = async () => {
        if (choice === value) { onDone(false); return; }
        setSaving(true);
        try {
            const { retention } = await api.setDeckRetention(projectId, choice);
            // Every review surface reads the target off the project row: set it
            // from the answer, so a failed list reload cannot leave the old one.
            useStore.setState(s => ({
                projects: s.projects.map(p => (p.id === projectId ? { ...p, desired_retention: retention } : p)),
            }));
            void loadProjects({ silent: true });
            onDone(true);
        } catch (e: any) {
            addToast('error', t("Could not save"), e.message);
            setSaving(false);
        }
    };

    return (
        <fieldset
            className="mt-4 w-full border-t border-slate-100 pt-3 dark:border-slate-700"
            onKeyDown={e => { if (e.key === 'Escape' && !saving) { e.stopPropagation(); onDone(false); } }}
        >
            <legend className="sr-only">{t("Recall target")}</legend>
            <div className="max-w-md">
                <p className="text-sm font-medium text-slate-700 dark:text-slate-200">{t("Recall target")}</p>
                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                    {t("The chance you still remember a card when it comes back. Higher means better recall and more reviews. Counts include new cards, over the next 30 days.")}
                </p>
                <div className="-mx-2 mt-3 flex flex-col">
                    {options.map(r => {
                        const n = perDay(r);
                        const id = `retention-${projectId}-${Math.round(r * 100)}`;
                        return (
                            <label key={r} htmlFor={id} className="flex min-h-10 cursor-pointer items-center gap-3 rounded-lg px-2 hover:bg-slate-50 dark:hover:bg-slate-700/50">
                                <Radio
                                    id={id}
                                    name={`retention-${projectId}`}
                                    checked={choice === r}
                                    onChange={() => setChoice(r)}
                                    autoFocus={r === value}
                                />
                                <span className="w-10 text-sm font-medium tabular-nums text-slate-800 dark:text-slate-100">{pct(r)}</span>
                                <span className="text-sm text-slate-500 dark:text-slate-400">
                                    {r === REQUEST_RETENTION ? t("default") : ''}
                                </span>
                                <span className="ml-auto text-sm tabular-nums text-slate-600 dark:text-slate-300">
                                    {n != null
                                        ? t("about {{fmt}} reviews a day", { count: perDayShown(n), fmt: fmt(perDayShown(n)) })
                                        : failed
                                            ? ''
                                            : <Loader2 className="h-4 w-4 animate-spin text-slate-400" aria-label={t("Counting")} />}
                                </span>
                            </label>
                        );
                    })}
                </div>
                {failed && (
                    <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                        {t("Could not count the reviews. The target can still be saved.")}
                    </p>
                )}
                <div className="mt-3 flex justify-end gap-2">
                    <Button variant="quiet" onClick={() => onDone(false)} disabled={saving}>
                        {t("Cancel")}
                    </Button>
                    <Button variant="primary" onClick={() => void save()} disabled={saving}>
                        {t("Save")}
                    </Button>
                </div>
            </div>
        </fieldset>
    );
}
