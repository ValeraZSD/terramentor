import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollText, RefreshCw, Download, Trash2 } from 'lucide-react';
import { api } from '../../api';
import { useStore } from '../../store';
import type { ActivityEvent, ActivityStats } from '../../types';
import { Button, ButtonLink, IconButton } from '../ui/Button';
import Switch from '../ui/Switch';
import SegmentedControl from '../ui/SegmentedControl';
import ScrollShade from '../ui/ScrollShade';
import { SettingNote } from '../ui/SettingRow';
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

    // ONE BLOCK OF A DIVIDED CARD, not a card of its own. It is mounted inside
    // the "Records & diagnostics" section, which is already a card: drawn as a
    // second white card on the first it read as a box in a box, indented twice,
    // and — because it rendered as a FRAGMENT into the parent's `space-y-8` —
    // every one of its three top-level pieces took a 32px top margin, so the
    // caption stood 32px above its own paragraph and the paragraph 32px above
    // the card it introduced (measured 2026-09-23: 1,128px for the open section
    // at 800px, 1,320px on a phone). One root element, and the parent owns the
    // spacing between blocks.
    return (
        <div className="px-4 py-4">
            {/* The name and the switch share a line; the explanation runs the
                full width under both, so four lines of prose never push the
                switch into the middle of a paragraph. */}
            <div className="flex items-center justify-between gap-4">
                <h3 className="flex min-w-0 items-center gap-2 font-medium text-slate-900 dark:text-white">
                    <ScrollText className="w-4 h-4 shrink-0 text-accent-fg" aria-hidden="true" />
                    {tr("Activity log")}
                </h3>
                <Switch
                    className="shrink-0"
                    checked={stats ? stats.enabled : true}
                    onChange={toggle}
                    label={tr("Keep a local log")}
                />
            </div>
            <SettingNote className="mt-1">
                {tr("Model calls, background jobs, and projects added or removed. It records what the app did, never what you study — no topic titles, questions, notes or answers — so the file is safe to share if you need help with a problem.")}
            </SettingNote>

            {/* What filters and re-reads the list sits ABOVE it; what takes the
                file away or throws it out sits BELOW it, which is also where a
                destructive control belongs — not under the reader's thumb on
                the way down the page. */}
            <div className="mt-4 flex items-center gap-2">
                <SegmentedControl
                    // As wide as its two labels, like every other segmented
                    // control in the app. Stretched (`flex-1 max-w-xs`), the
                    // TRACK grew and the segments did not — they are sized by
                    // their words — so ~90px of empty grey trailed "Problems
                    // only" and the two segments read as different sizes.
                    label={tr("Which events")}
                    value={filter}
                    onChange={v => setFilter(v as 'all' | 'problems')}
                    options={[
                        { value: 'all', label: tr("Everything") },
                        { value: 'problems', label: tr("Problems only") },
                    ]}
                />
                <IconButton
                    onClick={() => void load(filter)}
                    busy={loading}
                    label={tr("Refresh")}
                    icon={<RefreshCw className="w-4 h-4" aria-hidden="true" />}
                />
            </div>

            {/* The tail. Fixed-width time and area so the eye can run down a
                column, the detail free to wrap, and the whole thing scrolls
                inside its own box rather than pushing the page around. The
                hairline frame is what says where that box is: without it the
                rows ran straight into the controls above and below. */}
            <div className="mt-3 overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700">
                <ScrollShade className="max-h-80" data-testid="activity-events">
                    {events.length === 0 ? (
                        <p className="px-3 py-6 text-sm text-slate-500 dark:text-slate-400">
                            {stats && !stats.enabled
                                ? tr("Recording is off, so nothing new is being written.")
                                : filter === 'problems'
                                    ? tr("Nothing has gone wrong since the log was cleared.")
                                    : tr("No events yet.")}
                        </p>
                    ) : (
                        <ul className="divide-y divide-slate-100 dark:divide-slate-700/70">
                            {events.map(e => (
                                /* Two lines, not one: on a phone the single-line
                                    row wrapped its detail into fragments UNDER a
                                    fixed-width kind column the detail no longer sat
                                    beside — the eye met the kind, then had to skip
                                    over it to find the rest of the sentence. The
                                    first line is the scan path (dot, when, what
                                    kind, how long); the second is what happened,
                                    reading from the left at the row's full width,
                                    indented past the dot so it stays the row's
                                    child. */
                                <li key={e.id} className="px-3 py-2 text-sm">
                                    <div className="flex items-center gap-2.5">
                                        <span className={`w-1.5 h-1.5 shrink-0 rounded-full ${LEVEL_DOT[e.level] || LEVEL_DOT.info}`} aria-hidden="true" />
                                        <span className="shrink-0 tabular-nums text-slate-500 dark:text-slate-400">
                                            {when(e.at, i18n.language)}
                                        </span>
                                        <span className="shrink-0 w-24 truncate text-slate-600 dark:text-slate-300" title={e.event}>
                                            {e.event}
                                        </span>
                                        <span className="flex-1" />
                                        {e.ms != null && (
                                            <span className="shrink-0 tabular-nums text-slate-500 dark:text-slate-400">
                                                {e.ms >= 1000 ? `${(e.ms / 1000).toFixed(1)}s` : t("{{ms}}ms", { ms: e.ms })}
                                            </span>
                                        )}
                                    </div>
                                    {/* The dash is for an event with nothing to say at
                                        all — a project's name is something to say,
                                        so "— · Log probe" is not a thing. */}
                                    <div className="pl-4 mt-0.5 text-slate-700 dark:text-slate-200 break-words">
                                        {e.detail}
                                        {e.detail && e.projectTitle ? ' · ' : ''}
                                        {e.projectTitle && (
                                            <span className="text-slate-500 dark:text-slate-400">{e.projectTitle}</span>
                                        )}
                                        {!e.detail && !e.projectTitle && (
                                            // slate-400 was 2.56:1 on white (third-party
                                            // audit) — the pair the rest of the row uses
                                            // reads everywhere it is drawn.
                                            <span className="text-slate-500 dark:text-slate-400">—</span>
                                        )}
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                </ScrollShade>
            </div>

            {/* The count is the WHOLE log's, not the fifty rows above, so it
                sits beside the two actions on the whole log. Narrow, it takes
                its own line and the actions stay right. */}
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                <p className="min-w-0 flex-1 basis-48 text-sm text-slate-500 dark:text-slate-400" data-testid="activity-stats">
                    {stats
                        ? tr("{{rows}} of {{max}} events kept · {{problems}} warning or error", { count: stats.max,
                            rows: num(stats.rows), max: num(stats.max), problems: num(stats.problems),
                        })
                        : '…'}
                </p>
                <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">
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
            </div>
        </div>
    );
}
