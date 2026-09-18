import { useEffect, useState } from 'react';
import { api } from '../../api';
import { useStore } from '../../store';
import Modal from '../Modal';
import { TodayActivity, TodayActivityEvent } from '../../types';
import { parseDate } from '../../utils/tree';
import {
    BookOpen, CheckCircle2, HelpCircle, Layers, Loader2, MinusCircle, XCircle,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { k } from '../../i18n';
import { uiLocale } from '../../utils/locale';

interface Props {
    date: string;
    onClose: () => void;
}

const KIND_META: Record<TodayActivityEvent['kind'], { icon: typeof Layers; label: string }> = {
    card: { icon: Layers, label: k("Flashcard") },
    question: { icon: HelpCircle, label: k("Question") },
    lesson: { icon: BookOpen, label: k("Lesson") },
    topic: { icon: CheckCircle2, label: k("Topic") },
};

/** 15:26, in the learner's own clock. The stored value is UTC ISO. */
function clockTime(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
        ? ''
        : d.toLocaleTimeString(uiLocale(), { hour: '2-digit', minute: '2-digit', hour12: false });
}

/**
 * What the learner did today, from the records themselves.
 *
 * Opened from the feed header's chips, which are counters — this is the ledger
 * they are counted from, so every number above the list can be checked against
 * the rows below it. Each row deep-links to the topic it belongs to, because
 * "what did I get wrong this morning" is only useful if you can go back to it.
 */
export default function TodayActivityModal({ date, onClose }: Props) {
    const { t } = useTranslation();
    const openProjectNode = useStore(s => s.openProjectNode);
    const [data, setData] = useState<TodayActivity | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [projectFilter, setProjectFilter] = useState<number | null>(null);

    useEffect(() => {
        let cancelled = false;
        api.getTodayActivity(date)
            .then(d => { if (!cancelled) setData(d); })
            .catch(e => { if (!cancelled) setError(e?.message || 'Could not load today’s activity'); });
        return () => { cancelled = true; };
    }, [date]);

    const dateLabel = parseDate(date).toLocaleDateString(uiLocale(), {
        weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
    });

    const events = data
        ? (projectFilter == null ? data.events : data.events.filter(e => e.projectId === projectFilter))
        : [];

    return (
        <Modal isOpen onClose={onClose} title={dateLabel} maxWidth="max-w-2xl">
            {error && (
                <p className="py-8 text-center text-sm text-red-600 dark:text-red-400">{error}</p>
            )}

            {!data && !error && (
                <p className="py-10 flex items-center justify-center gap-2 text-sm text-slate-500 dark:text-slate-400">
                    <Loader2 className="w-4 h-4 animate-spin" /> {t("Loading today’s activity…")}
                </p>
            )}

            {data && (
                <>
                    {/* The four numbers the chips show, each said in full. Cards and
                        answers are separate on purpose: a card on the (re)learning
                        ladder is answered more than once in a sitting. */}
                    <dl className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                        <Stat
                            label={t("cards")}
                            value={data.summary.cards}
                            sub={data.summary.cardAnswers !== data.summary.cards
                                ? `${data.summary.cardAnswers} answers`
                                : undefined}
                        />
                        <Stat
                            label={t("questions")}
                            value={data.summary.questionsAnswered}
                            sub={data.summary.accuracy != null
                                ? `${Math.round(data.summary.accuracy * 100)}% correct`
                                : undefined}
                        />
                        <Stat label={t("lessons")} value={data.summary.lessonsRead} />
                        <Stat label={t("topics closed")} value={data.summary.topicsClosed} />
                    </dl>

                    {data.projects.length > 1 && (
                        <div className="mt-4 flex flex-wrap gap-1.5">
                            <FilterChip
                                active={projectFilter == null}
                                onClick={() => setProjectFilter(null)}
                                label={t("All")}
                            />
                            {data.projects.map(p => (
                                <FilterChip
                                    key={p.projectId}
                                    active={projectFilter === p.projectId}
                                    onClick={() => setProjectFilter(p.projectId)}
                                    label={`${p.name} · ${p.events}`}
                                    color={p.color}
                                />
                            ))}
                        </div>
                    )}

                    {events.length === 0 ? (
                        <p className="py-10 text-center text-sm text-slate-500 dark:text-slate-400">
                            {t("Nothing recorded yet today.")}
                        </p>
                    ) : (
                        <ul className="mt-4 -mx-2 divide-y divide-slate-100 dark:divide-slate-700/60">
                            {events.map((e, i) => (
                                <ActivityRow
                                    key={`${e.kind}-${e.at}-${e.nodeId}-${i}`}
                                    event={e}
                                    onOpen={() => { openProjectNode(e.projectId, e.nodeId); onClose(); }}
                                />
                            ))}
                        </ul>
                    )}

                    {data.truncated > 0 && (
                        <p className="mt-3 text-center text-sm text-slate-500 dark:text-slate-400">
                            {t("and {{truncated}} more today", { truncated: data.truncated })}
                        </p>
                    )}
                </>
            )}
        </Modal>
    );
}

function Stat({ label, value, sub }: { label: string; value: number; sub?: string }) {
    return (
        <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/40 px-3 py-2">
            <dd className="text-xl font-semibold text-slate-900 dark:text-white tabular-nums">{value}</dd>
            <dt className="text-xs text-slate-500 dark:text-slate-400">{label}</dt>
            {sub && <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">{sub}</p>}
        </div>
    );
}

function FilterChip({ active, onClick, label, color }: {
    active: boolean; onClick: () => void; label: string; color?: string | null;
}) {
    return (
        <button
            onClick={onClick}
            // Capped, not `max-w-full`: a project titled "Physics — Higher Level
            // / Mock Exam Preparation" is one chip per row otherwise, and the
            // filter row pushes the list it filters off the screen.
            className={`inline-flex items-center gap-1.5 max-w-[13rem] px-2.5 py-1 rounded-full text-xs border transition ${active
                ? 'bg-accent/10 border-accent/40 text-accent-fg'
                : 'bg-slate-50 dark:bg-slate-900/40 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-slate-300 dark:hover:border-slate-600'}`}
        >
            {color && <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} aria-hidden="true" />}
            <span className="truncate">{label}</span>
        </button>
    );
}

function ActivityRow({ event, onOpen }: { event: TodayActivityEvent; onOpen: () => void }) {
    const { t } = useTranslation();
    const { icon: Icon, label: labelKey } = KIND_META[event.kind];
    const label = t(labelKey);
    // A card rated "Again" and a question answered wrong are the two rows worth
    // finding in a long list, so they are the only ones that carry a colour.
    const verdict = event.correct === false
        ? { Icon: XCircle, cls: 'text-red-500' }
        : event.kind === 'topic' && event.detail === 'Skipped'
            ? { Icon: MinusCircle, cls: 'text-slate-400' }
            : null;

    return (
        <li>
            <button
                onClick={onOpen}
                title={t("{{label}} · {{nodeTitle}} — open the topic", { label, nodeTitle: event.nodeTitle })}
                className="w-full flex items-start gap-3 px-2 py-2 text-left rounded-lg hover:bg-slate-50 dark:hover:bg-slate-900/40 transition"
            >
                <span className="mt-0.5 text-[11px] tabular-nums text-slate-500 dark:text-slate-400 w-10 shrink-0">
                    {clockTime(event.at)}
                </span>
                <Icon className="w-4 h-4 mt-0.5 shrink-0 text-slate-400 dark:text-slate-500" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                    <span className="block text-sm text-slate-800 dark:text-slate-100 truncate">{event.title}</span>
                    <span className="block text-[11px] text-slate-500 dark:text-slate-400 truncate">
                        <span
                            className="inline-block w-1.5 h-1.5 rounded-full mr-1.5 align-middle"
                            style={{ backgroundColor: event.projectColor || '#94a3b8' }}
                            aria-hidden="true"
                        />
                        {event.kind === 'card' || event.kind === 'lesson' ? `${event.nodeTitle} · ` : ''}
                        {label}
                    </span>
                </span>
                <span className={`shrink-0 flex items-center gap-1 text-[11px] ${verdict ? verdict.cls : 'text-slate-500 dark:text-slate-400'}`}>
                    {verdict && <verdict.Icon className="w-3.5 h-3.5" aria-hidden="true" />}
                    {event.detail}
                </span>
            </button>
        </li>
    );
}
