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
import { Chip } from '../ui/Chip';
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
                // A course with nothing on the new day has no chip to clear it.
                setProjectFilter(f => (f != null && !d.projects.some(p => p.projectId === f) ? null : f));
            })
            .catch(() => {
                if (cancelled) return;
                // Not the previous day left under the new day's title.
                setData(null);
                setError(t("Could not load today’s activity."));
            });
        return () => { cancelled = true; };
    }, [day, t]);

    const dateLabel = parseDate(day).toLocaleDateString(uiLocale(), {
        weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
    });

    const events = data
        ? (projectFilter == null ? data.events : data.events.filter(e => e.projectId === projectFilter))
        : [];
    const loading = data != null && data.date !== day;
    // The counts are the whole day's; under a course filter they would sit
    // beside that course's minutes and read as its own.
    const done = data && projectFilter == null ? doneLine(data.summary, t) : null;
    // An empty day is this one sentence, standing where the total would:
    // before, it was a dash, a paragraph, four zeros and then the sentence.
    const lead = data != null && data.events.length === 0 && (
        <p className="text-base text-slate-600 dark:text-slate-300">
            {day === date ? t("Nothing recorded yet today.") : t("Nothing recorded on this day.")}
        </p>
    );

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
                // The title follows the pressed day at once; the body follows
                // when its day arrives (after the clock's flush, about a
                // second). Until then it is faded, or Friday's title stood
                // over Tuesday's minutes.
                <div aria-busy={loading} className={`transition-opacity ${loading ? 'opacity-40' : ''}`}>
                    <DayStudyTime
                        time={{ ...data.time, week: week ?? data.time.week }}
                        day={day}
                        onPickDay={setDay}
                        projectFilter={projectFilter}
                        onOpenTopic={(projectId, nodeId) => { openProjectNode(projectId, nodeId); onClose(); }}
                        done={done}
                        lead={lead}
                    />

                    {/* Gated on the DAY's events, not the filtered list: a
                        course with nothing left in it hid its own chips, and
                        with them the only way back to All. */}
                    {data.events.length > 0 && (
                        // Inert while the next day loads, so a row pressed
                        // there does not open the day being left; not the
                        // whole body, which would blur the bar just pressed.
                        <div inert={loading} className="mt-5 border-t border-slate-200 pt-4 dark:border-slate-700">
                            {data.projects.length > 1 && (
                                <div className="mb-2 flex flex-wrap gap-1.5">
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
                            <ul className="-mx-2 divide-y divide-slate-100 dark:divide-slate-700/60">
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
                        </div>
                    )}

                    {data.truncated > 0 && (
                        <p className="mt-3 text-center text-sm text-slate-500 dark:text-slate-400">
                            {t("and {{truncated}} more today", { truncated: data.truncated })}
                        </p>
                    )}
                </div>
            )}
        </Modal>
    );
}

/**
 * What the day FINISHED, as one wrapping row: "5 cards reviewed (6 answers)
 * 3 questions in the feed, 67% correct  1 topic finished". A skip is its own
 * item, never a finish (the row below it says "Skipped"). A count of zero is
 * left out and a day with none has no line: four boxed zeros under "2 min
 * studied" were read as the time not counting.
 *
 * Cards and answers stay apart on purpose: a card on the (re)learning ladder
 * is answered more than once in a sitting. Each noun is a plural key read
 * with its own number, so "20 карточки", "2 уроки" never happen.
 */
function doneLine(s: TodayActivity['summary'], t: TFunction): React.ReactNode {
    const parts: { key: string; n: number; label: string; extra?: string }[] = [
        {
            key: 'cards', n: s.cards, label: t("cards reviewed", { count: s.cards }),
            extra: s.cardAnswers !== s.cards ? ` (${t("{{count}} answers", { count: s.cardAnswers })})` : undefined,
        },
        {
            key: 'questions', n: s.questionsAnswered, label: t("feed questions", { count: s.questionsAnswered }),
            extra: s.accuracy != null ? `, ${t("{{pct}}% correct", { pct: Math.round(s.accuracy * 100) })}` : undefined,
        },
        // Quizzes, checks, written work: a day of only a mastery check was
        // otherwise a list under an empty top.
        { key: 'tests', n: s.otherAssessments, label: t("tests taken", { count: s.otherAssessments }) },
        { key: 'lessons', n: s.lessonsRead, label: t("lessons read", { count: s.lessonsRead }) },
        { key: 'topics', n: s.topicsClosed - s.topicsSkipped, label: t("topics finished", { count: s.topicsClosed - s.topicsSkipped }) },
        { key: 'skipped', n: s.topicsSkipped, label: t("topics skipped", { count: s.topicsSkipped }) },
    ].filter(p => p.n > 0);
    if (!parts.length) return null;
    // A gap, not " · ": each item opens on its bold number, which already
    // marks where it starts, and a wrapped dot dangled at a phone's line end.
    return (
        <ul className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-slate-600 dark:text-slate-300">
            {parts.map(p => (
                <li key={p.key} className="whitespace-nowrap">
                    <span className="font-semibold tabular-nums text-slate-900 dark:text-white">{p.n}</span> {p.label}{p.extra}
                </li>
            ))}
        </ul>
    );
}

function FilterChip({ active, onClick, label, color }: {
    active: boolean; onClick: () => void; label: string; color?: string | null;
}) {
    return (
        <Chip
            onClick={onClick}
            tone={active ? 'accent' : 'neutral'}
            aria-pressed={active}
            // Capped, not `max-w-full`: a project titled "Physics — Higher Level
            // / Mock Exam Preparation" is one chip per row otherwise, and the
            // filter row pushes the list it filters off the screen.
            className="max-w-[13rem]"
            icon={color ? <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} aria-hidden="true" /> : undefined}
        >
            <span className="truncate">{label}</span>
        </Chip>
    );
}

function ActivityRow({ event, onOpen }: { event: TodayActivityEvent; onOpen: () => void }) {
    const { t } = useTranslation();
    const { icon: kindIcon, label: labelKey } = KIND_META[event.kind];
    // A skipped topic is not ticked: a check beside "Skipped" said finished.
    const Icon = event.kind === 'topic' && event.skipped ? MinusCircle : kindIcon;
    const label = t(event.kind === 'question' ? SOURCE_LABEL[event.source ?? 'quiz'] ?? labelKey : labelKey);
    const detail = eventDetail(event, t);
    // A card rated "Again" and a question answered wrong are the two rows worth
    // finding in a long list, so they are the only ones that carry a colour.
    const verdict = event.correct === false ? { Icon: XCircle, cls: 'text-red-500' } : null;

    return (
        <li>
            <button
                type="button"
                data-row="activity"
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
                        {/* A card's title is its question, so its topic is news;
                            a lesson's title IS its topic and said it twice. */}
                        {event.kind === 'card' ? `${event.nodeTitle} · ` : ''}
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
