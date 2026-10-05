import { useEffect, useState } from 'react';
import { api } from '../../api';
import { useStore } from '../../store';
import Modal from '../Modal';
import { TodayActivity, TodayActivityEvent } from '../../types';
import { parseDate } from '../../utils/tree';
import {
    BookOpen, CheckCircle2, ChevronRight, HelpCircle, Layers, Loader2, MinusCircle, XCircle,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { k } from '../../i18n';
import { uiLocale } from '../../utils/locale';
import SittingReviewView from './SittingReviewView';
import { DayStudyTime } from '../studyTime/StudyTime';
import { flushStudyTime } from '../../hooks/useStudyClock';

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

/** What a scored row WAS. A mastery check of seven questions is not "a question". */
const SOURCE_LABEL: Record<string, string> = {
    feed: k("Question"),
    quiz: k("Quiz"),
    mastery_check: k("Mastery check"),
    paper: k("Written work"),
    drill: k("Practice drill"),
    placement: k("Placement"),
};

const RATING_LABEL: Record<number, string> = { 1: k("Again"), 2: k("Hard"), 3: k("Good"), 4: k("Easy") };

/** The right-hand word of a row, from the facts the server sends. */
function eventDetail(e: TodayActivityEvent, t: TFunction): string {
    switch (e.kind) {
        case 'card':
            return e.rating != null && RATING_LABEL[e.rating] ? t(RATING_LABEL[e.rating]) : '';
        case 'question':
            if (e.total === 1) return (e.score ?? 0) >= 1 ? t("Correct") : t("Wrong");
            return t("{{score}} of {{total}} correct", { score: e.score ?? 0, total: e.total ?? 0 });
        case 'lesson':
            return e.part ? t("Part {{n}}", { n: e.part }) : t("Lesson");
        case 'topic':
            return e.skipped ? t("Skipped") : t("Completed");
    }
}

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
    // A check or quiz row opened to its answers, in place of the ledger.
    const [reviewing, setReviewing] = useState<number | null>(null);
    // The day on show: today, or a day of this week opened from its bar. The
    // week is the one up to TODAY and stays put while its days are opened —
    // a strip that re-centred on every press would move the bar just pressed.
    const [day, setDay] = useState(date);
    const [week, setWeek] = useState<TodayActivity['time']['week'] | null>(null);

    useEffect(() => {
        let cancelled = false;
        setError(null);
        // What the study clock is still holding goes first, so today's time
        // includes the last minute rather than ending half a minute ago.
        flushStudyTime()
            .then(() => api.getTodayActivity(day))
            .then(d => {
                if (cancelled) return;
                setData(d);
                setWeek(w => w ?? d.time?.week ?? null);
            })
            .catch(() => { if (!cancelled) setError(t("Could not load today’s activity.")); });
        return () => { cancelled = true; };
    }, [day, t]);

    const dateLabel = parseDate(day).toLocaleDateString(uiLocale(), {
        weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
    });

    const events = data
        ? (projectFilter == null ? data.events : data.events.filter(e => e.projectId === projectFilter))
        : [];

    return (
        <Modal isOpen onClose={onClose} title={dateLabel} maxWidth="max-w-2xl">
            {reviewing != null && (
                <SittingReviewView evidenceId={reviewing} onBack={() => setReviewing(null)} onLeave={onClose} />
            )}

            {reviewing == null && error && (
                <p className="py-8 text-center text-sm text-red-600 dark:text-red-400">{error}</p>
            )}

            {reviewing == null && !data && !error && (
                <p className="py-10 flex items-center justify-center gap-2 text-sm text-slate-500 dark:text-slate-400">
                    <Loader2 className="w-4 h-4 animate-spin" /> {t("Loading today’s activity…")}
                </p>
            )}

            {reviewing == null && data && (
                <>
                    {data.time && (
                        <DayStudyTime
                            time={{ ...data.time, week: week ?? data.time.week }}
                            day={day}
                            onPickDay={setDay}
                            projectFilter={projectFilter}
                            onOpenTopic={(projectId, nodeId) => { openProjectNode(projectId, nodeId); onClose(); }}
                        />
                    )}
                    {/* The four numbers the chips show, each said in full. Cards and
                        answers are separate on purpose: a card on the (re)learning
                        ladder is answered more than once in a sitting. */}
                    {/* Each label is a plural key read with the tile's own number:
                        a fixed word under it read "20 карточки", "2 уроки",
                        "1 тем закрыто" in Russian. */}
                    <dl className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                        <Stat
                            label={t("cards reviewed", { count: data.summary.cards })}
                            value={data.summary.cards}
                            sub={data.summary.cardAnswers !== data.summary.cards
                                ? t("{{count}} answers", { count: data.summary.cardAnswers })
                                : undefined}
                        />
                        <Stat
                            label={t("feed questions", { count: data.summary.questionsAnswered })}
                            value={data.summary.questionsAnswered}
                            sub={data.summary.accuracy != null
                                ? t("{{pct}}% correct", { pct: Math.round(data.summary.accuracy * 100) })
                                : undefined}
                        />
                        <Stat label={t("lessons read", { count: data.summary.lessonsRead })} value={data.summary.lessonsRead} />
                        <Stat label={t("topics finished", { count: data.summary.topicsClosed })} value={data.summary.topicsClosed} />
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
                        // A day with study time but nothing answered or closed
                        // is not "nothing": the time above says what it was, and
                        // the zeros beside it say the rest.
                        (data.time?.totalMs ?? 0) > 0 ? null : (
                            <p className="py-10 text-center text-sm text-slate-500 dark:text-slate-400">
                                {day === date ? t("Nothing recorded yet today.") : t("Nothing recorded on this day.")}
                            </p>
                        )
                    ) : (
                        <ul className="mt-4 -mx-2 divide-y divide-slate-100 dark:divide-slate-700/60">
                            {events.map((e, i) => (
                                <ActivityRow
                                    key={`${e.kind}-${e.at}-${e.nodeId}-${i}`}
                                    event={e}
                                    onOpen={() => {
                                        // A sitting kept with its answers opens to them;
                                        // anything else goes to its topic.
                                        if (e.evidenceId != null) { setReviewing(e.evidenceId); return; }
                                        openProjectNode(e.projectId, e.nodeId);
                                        onClose();
                                    }}
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
            {sub && <p className="text-2xs text-slate-500 dark:text-slate-400 mt-0.5">{sub}</p>}
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
    const label = t(event.kind === 'question' ? SOURCE_LABEL[event.source ?? 'quiz'] ?? labelKey : labelKey);
    const detail = eventDetail(event, t);
    // A card rated "Again" and a question answered wrong are the two rows worth
    // finding in a long list, so they are the only ones that carry a colour.
    const verdict = event.correct === false
        ? { Icon: XCircle, cls: 'text-red-500' }
        : event.kind === 'topic' && event.skipped
            ? { Icon: MinusCircle, cls: 'text-slate-400' }
            : null;

    return (
        <li>
            <button
                onClick={onOpen}
                title={event.evidenceId != null
                    ? t("{{label}} · {{nodeTitle}} — see each answer", { label, nodeTitle: event.nodeTitle })
                    : t("{{label}} · {{nodeTitle}} — open the topic", { label, nodeTitle: event.nodeTitle })}
                className="w-full flex items-start gap-3 px-2 py-2 text-left rounded-lg hover:bg-slate-50 dark:hover:bg-slate-900/40 transition"
            >
                <span className="mt-0.5 text-2xs tabular-nums text-slate-500 dark:text-slate-400 w-10 shrink-0">
                    {clockTime(event.at)}
                </span>
                <Icon className="w-4 h-4 mt-0.5 shrink-0 text-slate-400 dark:text-slate-500" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                    <span className="block text-sm text-slate-800 dark:text-slate-100 truncate">{event.title}</span>
                    <span className="block text-2xs text-slate-500 dark:text-slate-400 truncate">
                        <span
                            className="inline-block w-1.5 h-1.5 rounded-full mr-1.5 align-middle"
                            style={{ backgroundColor: event.projectColor || '#94a3b8' }}
                            aria-hidden="true"
                        />
                        {event.kind === 'card' || event.kind === 'lesson' ? `${event.nodeTitle} · ` : ''}
                        {label}
                    </span>
                </span>
                <span className={`shrink-0 flex items-center gap-1 text-2xs ${verdict ? verdict.cls : 'text-slate-500 dark:text-slate-400'}`}>
                    {verdict && <verdict.Icon className="w-3.5 h-3.5" aria-hidden="true" />}
                    {detail}
                    {/* This row opens to its answers, not to the topic. */}
                    {event.evidenceId != null && <ChevronRight className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" />}
                </span>
            </button>
        </li>
    );
}
