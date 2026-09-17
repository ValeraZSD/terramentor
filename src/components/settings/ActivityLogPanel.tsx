import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollText, RefreshCw, Download, Trash2 } from 'lucide-react';
import { api } from '../../api';
import { useStore } from '../../store';
import type { ActivityEvent, ActivityStats } from '../../types';
import { Button, ButtonLink } from '../ui/Button';
import Switch from '../ui/Switch';
import SegmentedControl from '../ui/SegmentedControl';
import { useNumberFormat } from '../../hooks/useNumberFormat';

/**
 * Settings → Data → "Activity log": what the app has been doing, on this
 * machine, in a place a person can actually look.
 *
 * The console already had all of this and the console is not a place — it is
 * behind a terminal the reader never started, and it is gone when the window
 * closes. So the same events are rows now, and this panel is the tail of them
 * plus the two things you do with a log: take the file, or throw it away.
 *
 * What it deliberately does NOT do:
 *
 *  * poll. A log is read when someone opens it, and the refresh is a button.
 *    (`NodeTree` polling `/api/projects` every three seconds is the mistake
 *    this app already made once.)
 *  * hold the whole log. The panel asks for the last 50 events, and the rest
 *    lives in the file — a screen that renders 20,000 rows is not a log viewer,
 *    it is a way to make Settings slow.
 *  * send anything. The download is a link the browser follows; the app makes
 *    no request to anyone. Same shape as the bug-report block.
 */

const PAGE = 50;

/** Timestamp as a person reads it: the clock, plus the day when it is not today. */
function when(iso: string, locale: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    const time = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return sameDay ? time : `${d.toLocaleDateString(locale, { day: 'numeric', month: 'short' })} ${time}`;
}

const LEVEL_DOT: Record<string, string> = {
    info: 'bg-slate-300 dark:bg-slate-600',
    warn: 'bg-amber-500',
    error: 'bg-red-500',
};

export default function ActivityLogPanel() {
    const { t } = useTranslation();
    const num = useNumberFormat();
    const { t: tr, i18n } = useTranslation();
    const addToast = useStore(s => s.addToast);
    const showConfirm = useStore(s => s.showConfirm);

    const [events, setEvents] = useState<ActivityEvent[]>([]);
    const [stats, setStats] = useState<ActivityStats | null>(null);
    const [filter, setFilter] = useState<'all' | 'problems'>('all');
    const [loading, setLoading] = useState(false);

    const load = useCallback(async (level: 'all' | 'problems') => {
        setLoading(true);
        try {
            const r = await api.getActivity({ limit: PAGE, level: level === 'problems' ? 'problems' : undefined });
            setEvents(r.events);
            setStats(r.stats);
        } catch (e: any) {
            addToast('error', tr("Could not read the activity log"), e.message);
        } finally {
            setLoading(false);
        }
    }, [addToast, tr]);

    useEffect(() => { void load(filter); }, [load, filter]);

    const toggle = async (on: boolean) => {
        // Optimistic: the switch is the one control here whose lag would be felt.
        setStats(s => (s ? { ...s, enabled: on } : s));
        try {
            await api.setSetting('activity_log_enabled', on ? 'true' : 'false');
            await load(filter);
        } catch (e: any) {
            setStats(s => (s ? { ...s, enabled: !on } : s));
            addToast('error', tr("Could not save"), e.message);
        }
    };

    const clear = async () => {
        const ok = await showConfirm({
            title: tr("Clear the activity log?"),
            message: tr("Every recorded event is deleted. Nothing else is touched — your projects, cards and notes are not in this log."),
            confirmLabel: tr("Clear"),
            variant: 'danger',
        });
        if (!ok) return;
        try {
            await api.clearActivity();
            await load(filter);
        } catch (e: any) {
            addToast('error', tr("Could not clear the log"), e.message);
        }
    };

    return (
        <>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-white mb-1 flex items-center gap-2">
                <ScrollText className="w-5 h-5 text-accent-fg" aria-hidden="true" /> {tr("Activity log")}
            </h2>
            <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
                {tr("What the app has been doing on this machine — model calls, background jobs, projects created and removed. It records what the software did, never what you are studying: no topic titles, no questions, no notes, no model answers. Nothing here is sent anywhere; the file is yours to hand to someone if you want help with a problem.")}
            </p>

            <div className="bg-white dark:bg-slate-800 rounded-xl shadow-sm divide-y divide-slate-100 dark:divide-slate-700">
                <div className="px-4 py-3 flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                        <p className="text-sm font-medium text-slate-800 dark:text-slate-100">{tr("Keep a local log")}</p>
                        <p className="text-sm text-slate-500 dark:text-slate-400" data-testid="activity-stats">
                            {stats
                                ? tr("{{rows}} of {{max}} events kept · {{problems}} warning or error", {
                                    rows: num(stats.rows), max: num(stats.max), problems: num(stats.problems),
                                })
                                : '…'}
                        </p>
                    </div>
                    <Switch
                        checked={stats ? stats.enabled : true}
                        onChange={toggle}
                        label={tr("Keep a local log")}
                    />
                </div>

                <div className="px-4 py-3 flex flex-wrap items-center gap-2">
                    <SegmentedControl
                        label={tr("Which events")}
                        value={filter}
                        onChange={v => setFilter(v as 'all' | 'problems')}
                        options={[
                            { value: 'all', label: tr("Everything") },
                            { value: 'problems', label: tr("Problems only") },
                        ]}
                    />
                    <Button
                        onClick={() => void load(filter)}
                        busy={loading}
                        icon={<RefreshCw className="w-4 h-4" aria-hidden="true" />}
                    >
                        {tr("Refresh")}
                    </Button>
                    <span className="flex-1" />
                    {/* A real link, not a fetch: the file goes straight from the
                        server to the browser's downloads, so a 20,000-line log
                        never passes through a string in this tab. */}
                    <ButtonLink
                        href={api.activityExportUrl()}
                        download
                        icon={<Download className="w-4 h-4" aria-hidden="true" />}
                    >
                        {tr("Download the full log")}
                    </ButtonLink>
                    <Button
                        variant="danger"
                        onClick={clear}
                        icon={<Trash2 className="w-4 h-4" aria-hidden="true" />}
                    >
                        {tr("Clear")}
                    </Button>
                </div>

                {/* The tail. Fixed-width time and area so the eye can run down a
                    column, the detail free to wrap, and the whole thing scrolls
                    inside its own box rather than pushing the page around. */}
                <div className="max-h-96 overflow-y-auto" data-testid="activity-events">
                    {events.length === 0 ? (
                        <p className="px-4 py-6 text-sm text-slate-500 dark:text-slate-400">
                            {stats && !stats.enabled
                                ? tr("Recording is off, so nothing new is being written.")
                                : filter === 'problems'
                                    ? tr("Nothing has gone wrong since the log was cleared.")
                                    : tr("No events yet.")}
                        </p>
                    ) : (
                        <ul className="divide-y divide-slate-100 dark:divide-slate-700/70">
                            {events.map(e => (
                                <li key={e.id} className="px-4 py-2 flex items-start gap-3 text-sm">
                                    <span className={`mt-1.5 w-1.5 h-1.5 shrink-0 rounded-full ${LEVEL_DOT[e.level] || LEVEL_DOT.info}`} aria-hidden="true" />
                                    <span className="shrink-0 tabular-nums text-slate-500 dark:text-slate-400">
                                        {when(e.at, i18n.language)}
                                    </span>
                                    <span className="shrink-0 w-24 truncate text-slate-600 dark:text-slate-300" title={e.event}>
                                        {e.event}
                                    </span>
                                    {/* The dash is for a row with nothing to say at
                                        all — a project's name is something to say,
                                        so "— · Log probe" is not a thing. */}
                                    <span className="min-w-0 flex-1 text-slate-700 dark:text-slate-200 break-words">
                                        {e.detail}
                                        {e.detail && e.projectTitle ? ' · ' : ''}
                                        {e.projectTitle && (
                                            <span className="text-slate-500 dark:text-slate-400">{e.projectTitle}</span>
                                        )}
                                        {!e.detail && !e.projectTitle && (
                                            <span className="text-slate-400 dark:text-slate-500">—</span>
                                        )}
                                    </span>
                                    {e.ms != null && (
                                        <span className="shrink-0 tabular-nums text-slate-500 dark:text-slate-400">
                                            {e.ms >= 1000 ? `${(e.ms / 1000).toFixed(1)}s` : t("{{ms}}ms", { ms: e.ms })}
                                        </span>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </div>
        </>
    );
}
