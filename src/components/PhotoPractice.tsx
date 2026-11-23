import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Check, ImageOff, Loader2, RotateCcw, X } from 'lucide-react';
import { api, newAttemptId } from '../api';
import { useStore } from '../store';
import { ExamFrame } from './mockExam/ExamFrame';
import ChoiceInput from './answer/ChoiceInput';
import ReportItem, { ReportLink, ReportScope } from './ui/ReportItem';
import { Button } from './ui/Button';
import { PhotoCredit } from './TopicPhoto';
import { useStudyClock } from '../hooks/useStudyClock';
import { useElementWidth } from '../hooks/useElementWidth';
import { useRootFontSize } from '../hooks/useRootFontSize';
import { photoRef } from '../utils/itemReports';
import { shortTitles } from '../utils/shortTitles';
import type { PhotoRoundItem, PhotoVerdict, QuizQuestion, TopicPhoto } from '../types';

/**
 * "Which one is this?": a round of the course's topic photos, each asked
 * among the course's topics learned by sight (server/photoPractice.js).
 *
 * One photo at a time, large, and the topics as the options; the server says
 * right or wrong. A right pick names the example, what to look at and the
 * photo's credit under it. A wrong pick puts the photo beside one of the topic
 * picked, each with what to look at, so the difference is seen, not only read.
 * Nothing that names the answer (the example, the credit) is on screen before
 * the pick.
 *
 * Opened like the mock exam: a view of the course with no tab of its own, the
 * app's chrome stepped aside (`ExamFrame`).
 */
export default function PhotoPractice({ projectId }: { projectId: number }) {
    const { t } = useTranslation();
    const project = useStore(s => s.projects.find(p => p.id === projectId) ?? null);
    const setWorkspaceView = useStore(s => s.setWorkspaceView);
    const addToast = useStore(s => s.addToast);

    const [items, setItems] = useState<PhotoRoundItem[] | null>(null);
    const [loadError, setLoadError] = useState<'none' | 'failed' | null>(null);
    const [at, setAt] = useState(0);
    const [verdicts, setVerdicts] = useState<(PhotoVerdict | null)[]>([]);
    const [reported, setReported] = useState<Set<number>>(new Set());
    const [picked, setPicked] = useState('');
    const [sending, setSending] = useState(false);
    const [done, setDone] = useState(false);
    // One id per presentation, kept for a retry of the same pick.
    const attempt = useRef<string>(newAttemptId());

    const draw = useCallback(async () => {
        setItems(null);
        setLoadError(null);
        setAt(0);
        setVerdicts([]);
        setReported(new Set());
        setPicked('');
        setDone(false);
        attempt.current = newAttemptId();
        try {
            const round = await api.drawPhotoRound(projectId);
            setItems(round.items);
        } catch (e: any) {
            setLoadError(e?.status === 409 ? 'none' : 'failed');
        }
    }, [projectId]);
    useEffect(() => { void draw(); }, [draw]);

    const item = items && !done ? items[at] ?? null : null;
    const verdict = verdicts[at] ?? null;
    useStudyClock(item ? { nodeId: item.nodeId, activity: 'questions' } : null);

    // The topics by the part of their title before a colon, the same for the
    // whole round: the rest describes the answer (src/utils/shortTitles.ts).
    const labels = useMemo(() => shortTitles(items?.flatMap(i => i.options.map(o => o.title)) ?? []), [items]);
    const label = useCallback((title: string) => labels.get(title) ?? title, [labels]);

    // Moved to the next step once the verdict is in, so Enter goes on.
    const nextRef = useRef<HTMLButtonElement>(null);
    const showsNext = !!item && (!!verdict || reported.has(at));
    useEffect(() => { if (showsNext) nextRef.current?.focus(); }, [showsNext, at]);
    // ...and Next, "Another round" and "Try again", each gone as it is
    // pressed, hand focus to the next photo's question or to the round's
    // score, never to the page; a new round's once its photos are in.
    const bodyRef = useRef<HTMLDivElement>(null);
    const movedOn = useRef(false);
    useEffect(() => {
        if (!movedOn.current) return;
        const start = bodyRef.current?.querySelector<HTMLElement>('[data-focus-start]');
        if (!start) return;
        movedOn.current = false;
        start.focus();
    }, [at, done, items]);
    const drawAgain = () => { movedOn.current = true; void draw(); };

    const leave = () => setWorkspaceView('dashboard');

    const pick = async (shown: string) => {
        if (!item || verdict || sending) return;
        const option = item.options.find(o => label(o.title) === shown);
        if (!option) return;
        setSending(true);
        try {
            const out = await api.answerPhoto(projectId, { photo: item.photo, picked: option.nodeId, attemptId: attempt.current });
            setVerdicts(v => { const next = [...v]; next[at] = out; return next; });
        } catch (e: any) {
            // Sent again with the same id, a pick that did reach the server is written once.
            addToast('error', t("Couldn't check your answer"), e?.message);
            setPicked('');
        } finally {
            setSending(false);
        }
    };

    const next = () => {
        if (!items) return;
        attempt.current = newAttemptId();
        setPicked('');
        movedOn.current = true;
        if (at + 1 >= items.length) setDone(true);
        else setAt(at + 1);
    };

    const title = t("Tell them apart");
    const total = items?.length ?? 0;
    const status = items && !done && total > 0 ? t("Photo {{n}} of {{total}}", { n: at + 1, total }) : undefined;
    const itemReported = reported.has(at);

    const footer = showsNext ? (
        <div className="mx-auto w-full max-w-3xl flex justify-end px-4 py-3 safe-pb-0">
            <Button ref={nextRef} variant="primary" size="md" onClick={next} icon={<ArrowRight className="w-4 h-4" aria-hidden="true" />}>
                {at + 1 >= total ? t("See how it went") : t("Next photo")}
            </Button>
        </div>
    ) : undefined;

    let body;
    if (loadError === 'none') {
        body = (
            <Centered>
                <p className="text-base text-slate-700 dark:text-slate-200">{t("This course has no photos to tell apart yet")}</p>
                <Button variant="neutral" size="md" onClick={leave}>{t("Back to the course")}</Button>
            </Centered>
        );
    } else if (loadError === 'failed') {
        body = (
            <Centered>
                <p className="text-base text-slate-700 dark:text-slate-200">{t("Couldn't load the photos.")}</p>
                <Button variant="neutral" size="md" onClick={drawAgain} icon={<RotateCcw className="w-4 h-4" aria-hidden="true" />}>{t("Try again")}</Button>
            </Centered>
        );
    } else if (!items) {
        body = (
            <Centered>
                <p role="status" className="flex items-center gap-2 text-base text-slate-600 dark:text-slate-300">
                    <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" />
                    {t("Getting the photos ready…")}
                </p>
            </Centered>
        );
    } else if (done || !item) {
        body = <RoundEnd items={items} verdicts={verdicts} label={label} onAgain={drawAgain} onLeave={leave} />;
    } else {
        body = (
            <Trial
                key={`${at}-${item.photo}`}
                item={item}
                verdict={verdict}
                label={label}
                picked={picked}
                // With "confirm before grading" on, the first press only selects.
                onSelect={setPicked}
                onPick={shown => { setPicked(shown); void pick(shown); }}
                sending={sending}
                reported={itemReported}
                onReported={() => setReported(r => new Set(r).add(at))}
                onUndone={() => setReported(r => { const s = new Set(r); s.delete(at); return s; })}
            />
        );
    }

    return (
        <ExamFrame title={project?.name ? `${title} · ${project.name}` : title} status={status} onLeave={leave} leaveLabel={t("Back")} footer={footer}>
            <div ref={bodyRef} className="contents">{body}</div>
        </ExamFrame>
    );
}

function Centered({ children }: { children: ReactNode }) {
    return <div className="mx-auto flex min-h-full max-w-md flex-col items-center justify-center gap-4 px-6 py-10 text-center">{children}</div>;
}

/** One photo, its question and options, and once picked its verdict. */
function Trial({ item, verdict, label, picked, onSelect, onPick, sending, reported, onReported, onUndone }: {
    item: PhotoRoundItem;
    verdict: PhotoVerdict | null;
    /** A topic's title as the round shows it. */
    label: (title: string) => string;
    picked: string;
    onSelect: (shown: string) => void;
    onPick: (shown: string) => void;
    sending: boolean;
    reported: boolean;
    onReported: () => void;
    onUndone: () => void;
}) {
    const { t } = useTranslation();
    const question = useMemo<QuizQuestion>(() => ({
        type: 'multiple_choice',
        question: '',
        options: item.options.map(o => label(o.title)),
        correct_answer: verdict ? label(verdict.answer.title) : '',
    }) as QuizQuestion, [item, verdict, label]);
    const pickedTitle = verdict
        ? label(verdict.correct ? verdict.answer.title : verdict.picked?.topic ?? picked)
        : picked;
    const answerTitle = verdict ? label(verdict.answer.title) : '';

    return (
        <ReportScope>
            <div className="mx-auto w-full max-w-3xl px-4 py-5 sm:py-8 space-y-5">
                <div className="flex items-start justify-between gap-3">
                    <h3 data-focus-start tabIndex={-1} className="text-lg font-semibold text-slate-900 dark:text-white focus:outline-none">{t("Which one is this?")}</h3>
                    <ReportItem
                        itemRef={photoRef(item.photo)}
                        surface="sight"
                        hideKey={!verdict}
                        shown={verdict ? { answer: pickedTitle, correct: verdict.correct } : undefined}
                        onReported={onReported}
                        onUndone={onUndone}
                    />
                </div>

                {/* The verdict comes first: on a phone the photos below fill the screen. */}
                <div aria-live="polite">
                    {verdict && (
                        <p className={`flex items-center gap-2 text-base font-medium ${verdict.correct ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'}`}>
                            {verdict.correct
                                ? <Check className="w-5 h-5 shrink-0" aria-hidden="true" />
                                : <X className="w-5 h-5 shrink-0" aria-hidden="true" />}
                            {verdict.correct
                                ? t("Right: {{topic}}", { topic: answerTitle })
                                : t("This is {{topic}}", { topic: answerTitle })}
                        </p>
                    )}
                </div>

                {verdict && !verdict.correct && verdict.picked
                    ? <Comparison shown={verdict.shown} picked={verdict.picked} pickedTopic={pickedTitle} />
                    : (
                        // As wide as the photo, so its caption starts where the photo does.
                        <figure className="mx-auto w-fit max-w-full">
                            <PracticePhoto hash={item.hash} width={item.width} height={item.height}
                                alt={verdict ? photoAlt(verdict.shown) : t("Photo to recognise")} large />
                            {verdict && (
                                <figcaption className="mt-3 w-0 min-w-full">
                                    <PhotoWords photo={verdict.shown} />
                                </figcaption>
                            )}
                        </figure>
                    )}

                <ChoiceInput
                    question={question}
                    value={pickedTitle}
                    onChange={onSelect}
                    onCommit={onPick}
                    disabled={sending || reported}
                    result={verdict ? { correct: verdict.correct, answer: pickedTitle } : null}
                />
                {verdict && !verdict.correct && <ReportLink />}
            </div>
        </ReportScope>
    );
}

const photoAlt = (p: Pick<TopicPhoto, 'subject' | 'shows'>) => (p.shows ? `${p.subject}. ${p.shows}` : p.subject);

/** The example's name, what to look at, and the photo's credit. */
function PhotoWords({ photo, compact = false }: { photo: TopicPhoto; compact?: boolean }) {
    return (
        <div className="space-y-1">
            <p className="text-base font-medium text-slate-900 dark:text-white">{photo.subject}</p>
            {photo.shows && <p className={`${compact ? 'text-sm' : 'text-base'} text-slate-700 dark:text-slate-200`}>{photo.shows}</p>}
            <PhotoCredit photo={photo} />
        </div>
    );
}

/** The photo, in its own shape, up to a height that leaves the options in view.
 *  `tile`: inside a 4:3 tile, so two photos of different shapes stand the same size. */
function PracticePhoto({ hash, width, height, alt, large = false, tile = false }: {
    hash: string; width: number | null; height: number | null; alt: string; large?: boolean; tile?: boolean;
}) {
    const { t } = useTranslation();
    const [broken, setBroken] = useState(false);
    if (broken || !/^[a-f0-9]{64}$/.test(hash)) {
        return (
            <div className={`flex items-center justify-center gap-2 px-4 text-center rounded-xl bg-slate-200 dark:bg-slate-800 text-sm text-slate-600 dark:text-slate-300 ${tile ? 'aspect-[4/3] w-full' : 'h-48 w-[28rem] max-w-full'}`}>
                <ImageOff className="w-4 h-4 shrink-0" aria-hidden="true" />
                {t("This photo could not be loaded.")}
            </div>
        );
    }
    const img = (
        <img
            src={`/api/media/${hash}`}
            alt={alt}
            width={width && width > 0 ? width : undefined}
            height={height && height > 0 ? height : undefined}
            decoding="async"
            onError={() => setBroken(true)}
            className={tile
                ? 'block w-auto h-auto max-w-full max-h-full'
                : `block w-auto h-auto max-w-full rounded-xl bg-slate-200 dark:bg-slate-800 ${large ? 'max-h-[min(28rem,55vh)]' : 'max-h-72'}`}
        />
    );
    return tile
        ? <div className="aspect-[4/3] w-full overflow-hidden rounded-xl bg-slate-200 dark:bg-slate-800 flex items-center justify-center">{img}</div>
        : img;
}

/** A wrong pick: the photo asked about beside one of the topic picked, each named and credited. */
function Comparison({ shown, picked, pickedTopic }: {
    shown: PhotoVerdict['shown']; picked: NonNullable<PhotoVerdict['picked']>; pickedTopic: string;
}) {
    const { t } = useTranslation();
    const ref = useRef<HTMLDivElement>(null);
    const width = useElementWidth(ref);
    const rem = useRootFontSize();
    // Side by side once each photo can be 15rem wide; stacked on a phone.
    const twoUp = width >= 31 * rem;
    // Each panel is a subgrid of one three-row grid, so the labels, the photo tiles and the
    // captions of the two panels start on the same lines whatever their lengths.
    const panel = (photo: TopicPhoto & { topic: string }, label: string) => (
        <figure className={twoUp ? 'min-w-0 row-span-3 grid grid-cols-1 grid-rows-subgrid' : 'min-w-0 space-y-2'}>
            <p className="text-sm font-semibold text-slate-600 dark:text-slate-300">{label}</p>
            <PracticePhoto hash={photo.hash} width={photo.width} height={photo.height} alt={photoAlt(photo)} tile={twoUp} />
            <figcaption><PhotoWords photo={photo} compact={twoUp} /></figcaption>
        </figure>
    );
    return (
        <div ref={ref} className={twoUp ? 'grid grid-cols-2 grid-rows-[auto_auto_auto] gap-x-5 gap-y-2' : 'space-y-6'}>
            {/* The pick is a topic, so its photo is labelled with that topic:
                "Your pick" alone read as a photo the learner had chosen. */}
            {panel(shown, t("This photo"))}
            {panel(picked, t("An example of {{topic}}", { topic: pickedTopic }))}
        </div>
    );
}

/** How the round went: the score, then each topic with what it was mistaken for. */
function RoundEnd({ items, verdicts, label, onAgain, onLeave }: {
    items: PhotoRoundItem[];
    verdicts: (PhotoVerdict | null)[];
    label: (title: string) => string;
    onAgain: () => void;
    onLeave: () => void;
}) {
    const { t } = useTranslation();
    const answered = verdicts.filter((v): v is PhotoVerdict => !!v);
    const right = answered.filter(v => v.correct).length;
    // Per topic, in the order the round first met it.
    const topics: { title: string; right: number; total: number; mistakenFor: string[] }[] = [];
    items.forEach((_, i) => {
        const v = verdicts[i];
        if (!v) return;
        const title = label(v.answer.title);
        let row = topics.find(r => r.title === title);
        if (!row) { row = { title, right: 0, total: 0, mistakenFor: [] }; topics.push(row); }
        row.total++;
        if (v.correct) row.right++;
        else if (v.picked && !row.mistakenFor.includes(label(v.picked.topic))) row.mistakenFor.push(label(v.picked.topic));
    });
    return (
        <div className="mx-auto w-full max-w-xl px-4 py-8 space-y-6">
            <div data-focus-start tabIndex={-1} className="text-center focus:outline-none">
                <p className="text-sm text-slate-600 dark:text-slate-300">{t("Right")}</p>
                <p className="text-4xl font-semibold tabular-nums text-slate-900 dark:text-white">
                    {t("{{right}} of {{total}}", { right, total: answered.length })}
                </p>
            </div>
            {topics.length > 0 && (
                <ul className="divide-y divide-slate-200 dark:divide-slate-700 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800">
                    {topics.map(r => (
                        <li key={r.title} className="flex items-start justify-between gap-4 px-4 py-3">
                            <div className="min-w-0">
                                <p className="text-base text-slate-900 dark:text-white">{r.title}</p>
                                {r.mistakenFor.length > 0 && (
                                    <p className="text-sm text-slate-600 dark:text-slate-300">
                                        {t("Mistaken for {{topics}}", { topics: r.mistakenFor.join(', ') })}
                                    </p>
                                )}
                            </div>
                            <span className="shrink-0 text-base tabular-nums text-slate-700 dark:text-slate-200">{r.right}/{r.total}</span>
                        </li>
                    ))}
                </ul>
            )}
            <div className="flex flex-wrap justify-center gap-3">
                <Button variant="neutral" size="md" onClick={onLeave}>{t("Back to the course")}</Button>
                <Button variant="primary" size="md" onClick={onAgain}>{t("Another round")}</Button>
            </div>
        </div>
    );
}
