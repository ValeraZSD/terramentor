import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, Pause, Play } from 'lucide-react';
import { api, newAttemptId } from '../../api';
import { useStore } from '../../store';
import { Button, IconButton } from '../ui/Button';
import { SegmentedControl } from '../ui/SegmentedControl';
import Stepper from '../ui/Stepper';
import Switch from '../ui/Switch';
import ProgressBar from '../ui/ProgressBar';
import { BottomSheet } from '../ui/Sheet';
import ReportItem from '../ui/ReportItem';
import Modal from '../Modal';
import QuestionStem from '../QuestionStem';
import AnswerInput from '../answer/AnswerInput';
import AnswerReviewItem from '../answer/AnswerReviewItem';
import { formatOf } from '../answer/formats';
import { useNumberFormat } from '../../hooks/useNumberFormat';
import { useElementWidth } from '../../hooks/useElementWidth';
import { useRootFontSize } from '../../hooks/useRootFontSize';
import { uiLocale } from '../../utils/locale';
import { k } from '../../i18n';
import { Row } from './MockExamView';
import { Panel } from './Panel';
import { useDuration } from './mockFormat';
import { openingPlace, saveState } from './courseMockState';
import { usePhysicalKeyboard } from '../../utils/platform';
import { isTextEntry } from '../../utils/escapeKey';
import { EXAM_BAR_TINY, ExamFrame, GridButton, QuestionGrid, QuestionStrip } from './ExamFrame';
import type { CourseMockDetail, CourseReadiness, RealExam, ReviewGroup } from './mockExamTypes';

/**
 * A mock exam drawn from the course's own questions and answered on screen
 * (server/mockExams.js, "the draw"). Three moments: the set-up, the questions
 * one at a time, and the result with the answers read back.
 */

const SIZES = [10, 20, 40] as const;

/** Minutes a draw of `size` gets when the real exam names none: 1.5 per question. */
const minutesFor = (size: number) => Math.max(1, Math.ceil(size * 1.5));

// ---- set-up ------------------------------------------------------------------------

export function CourseStartPanel({ projectId, course, onStarted, onChanged }: {
    projectId: number;
    course: CourseReadiness;
    onStarted: (id: number) => void;
    onChanged: () => void;
}) {
    const { t } = useTranslation();
    const addToast = useStore(s => s.addToast);
    const { exam } = course;
    const examSize = exam?.onScreen && exam.questions ? exam.questions : null;
    const sizes = useMemo(() => {
        const list: number[] = [...SIZES];
        if (examSize && !list.includes(examSize)) list.push(examSize);
        return list.sort((a, b) => a - b);
    }, [examSize]);
    const [size, setSize] = useState(course.defaultSize);
    const [clock, setClock] = useState(course.clockOn);
    const [minutes, setMinutes] = useState(exam?.onScreen && exam.minutes && size === examSize ? exam.minutes : minutesFor(size));
    const [busy, setBusy] = useState(false);
    const [describing, setDescribing] = useState(false);
    useEffect(() => { setSize(course.defaultSize); setClock(course.clockOn); }, [course.defaultSize, course.clockOn]);
    useEffect(() => {
        setMinutes(exam?.onScreen && exam.minutes && size === examSize ? exam.minutes : minutesFor(size));
    }, [size, exam, examSize]);

    if (course.ready === 0) {
        return (
            <Panel>
                <h3 className="text-base font-semibold text-slate-900 dark:text-white">{t("No questions ready yet")}</h3>
                <p className="mt-2 text-sm text-slate-600 dark:text-slate-300 max-w-prose">
                    {course.studied === 0
                        ? t("A mock asks questions from the topics you have started. Start a topic and answer its questions, then come back.")
                        : t("A mock asks the questions the app can check by itself, from the topics you have started. None of those topics has one yet.")}
                </p>
            </Panel>
        );
    }

    const drawn = Math.min(size, course.ready);
    const start = () => {
        setBusy(true);
        api.drawMock(projectId, size, clock ? minutes : null)
            .then(r => onStarted(r.sitting.id))
            .catch(e => addToast('error', e.message))
            .finally(() => setBusy(false));
    };
    const sizeLabel = (n: number) => n === examSize && !SIZES.includes(n as typeof SIZES[number])
        ? t("Like the exam, {{n}}", { n })
        : n === 10 ? t("Short, 10") : n === 20 ? t("Half, 20") : t("Full, 40");
    const examLine = !exam
        ? t("Not described yet")
        : !exam.onScreen
            ? t("On paper")
            : exam.passRight != null
                ? t("On screen, {{count}} questions, pass at {{pass}} right", { count: exam.questions ?? 0, pass: exam.passRight })
                : t("On screen, {{count}} questions", { count: exam.questions ?? 0 });

    return (
        <Panel>
            <h3 className="text-base font-semibold text-slate-900 dark:text-white">{t("This mock exam")}</h3>
            <div className="mt-2 divide-y divide-slate-200 dark:divide-slate-700">
                <Row label={t("Length")}>
                    <SegmentedControl label={t("Length")} value={size} onChange={setSize}
                        options={sizes.map(n => ({ value: n, label: sizeLabel(n) }))} />
                </Row>
                <Row label={t("Exam clock")}>
                    <div className="flex items-center gap-3">
                        {clock && <><Stepper value={minutes} min={1} max={600} step={5} onChange={setMinutes} label={t("Minutes")} className="w-36" /><span className="text-sm text-slate-600 dark:text-slate-300">{t("min")}</span></>}
                        <Switch checked={clock} onChange={on => { setClock(on); }} label={t("Exam clock")} />
                    </div>
                </Row>
                <Row label={t("The real exam")}>
                    <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
                        <span className="text-sm text-slate-700 dark:text-slate-200">{examLine}</span>
                        <Button size="sm" onClick={() => setDescribing(true)}>{exam ? t("Change") : t("Describe it")}</Button>
                    </div>
                </Row>
            </div>
            <div className="mt-4 rounded-xl bg-slate-100 dark:bg-slate-900/60 px-4 py-3 text-sm text-slate-700 dark:text-slate-300 space-y-1">
                <p>
                    {drawn < size
                        ? t("This course has {{count}} questions ready, so this mock asks {{count}}, not {{size}}.", { count: course.ready, size })
                        : t("{{count}} questions, drawn across the topics you have started. Answers and explanations come at the end.", { count: drawn })}
                </p>
                {(course.notStudied > 0 || course.writtenLeftOut > 0) && (
                    <p className="text-slate-600 dark:text-slate-400">
                        {[
                            course.notStudied > 0 ? t("{{count}} topics not started are left out.", { count: course.notStudied }) : null,
                            course.writtenLeftOut > 0 ? t("{{count}} written-answer questions are left out: the app cannot check them by itself.", { count: course.writtenLeftOut }) : null,
                        ].filter(Boolean).join(' ')}
                    </p>
                )}
            </div>
            <div className="mt-4 flex justify-end">
                <Button variant="primary" busy={busy} onClick={start}>{t("Start the mock")}</Button>
            </div>
            {describing && (
                <RealExamDialog projectId={projectId} exam={exam}
                    onClose={() => setDescribing(false)}
                    onSaved={() => { setDescribing(false); onChanged(); }} />
            )}
        </Panel>
    );
}

/** How the course's real exam is taken: it decides the clock's default and whether a pass line can show. */
function RealExamDialog({ projectId, exam, onClose, onSaved }: {
    projectId: number;
    exam: RealExam | null;
    onClose: () => void;
    onSaved: () => void;
}) {
    const { t } = useTranslation();
    const addToast = useStore(s => s.addToast);
    const [how, setHow] = useState<'unknown' | 'paper' | 'screen'>(!exam ? 'unknown' : exam.onScreen ? 'screen' : 'paper');
    const [questions, setQuestions] = useState(exam?.questions ?? 40);
    const [minutes, setMinutes] = useState(exam?.minutes ?? 60);
    const [hasPass, setHasPass] = useState(exam?.passRight != null);
    const [pass, setPass] = useState(exam?.passRight ?? Math.ceil((exam?.questions ?? 40) * 0.55));
    const [busy, setBusy] = useState(false);
    useEffect(() => { if (pass > questions) setPass(questions); }, [questions, pass]);

    const save = () => {
        setBusy(true);
        const body: Partial<RealExam> = how === 'unknown' ? {} : how === 'paper' ? { onScreen: false }
            : { onScreen: true, questions, minutes, passRight: hasPass ? pass : null };
        api.setRealExam(projectId, body)
            .then(onSaved)
            .catch(e => { addToast('error', e.message); setBusy(false); });
    };

    return (
        <Modal isOpen onClose={onClose} title={t("The real exam")} maxWidth="max-w-lg"
            footer={(
                <>
                    <Button onClick={onClose}>{t("Cancel")}</Button>
                    <Button variant="primary" busy={busy} onClick={save}>{t("Save")}</Button>
                </>
            )}>
            <div className="space-y-4">
                <p className="text-sm text-slate-600 dark:text-slate-300">
                    {t("How is the exam for this course taken? A mock gets a clock and a pass line only when the real exam is on screen in the same format.")}
                </p>
                <SegmentedControl label={t("How it is taken")} block="narrow" value={how} onChange={setHow}
                    options={[
                        { value: 'unknown', label: t("Not sure") },
                        { value: 'paper', label: t("On paper") },
                        { value: 'screen', label: t("On screen") },
                    ]} />
                {how === 'screen' && (
                    <div className="divide-y divide-slate-200 dark:divide-slate-700">
                        <Row label={t("Questions")}>
                            <Stepper value={questions} min={1} max={200} onChange={setQuestions} label={t("Questions")} className="w-36" />
                        </Row>
                        <Row label={t("Time allowed")}>
                            <div className="flex items-center gap-2"><Stepper value={minutes} min={1} max={600} step={5} onChange={setMinutes} label={t("Time allowed")} className="w-36" /><span className="text-sm text-slate-600 dark:text-slate-300">{t("min")}</span></div>
                        </Row>
                        <Row label={t("Pass line")}>
                            <div className="flex items-center gap-3">
                                {hasPass && <><Stepper value={pass} min={0} max={questions} onChange={setPass} label={t("Right answers to pass")} className="w-36" /><span className="text-sm text-slate-600 dark:text-slate-300">{t("right")}</span></>}
                                <Switch checked={hasPass} onChange={on => { setHasPass(on); }} label={t("Pass line")} />
                            </div>
                        </Row>
                    </div>
                )}
            </div>
        </Modal>
    );
}

// ---- answering -----------------------------------------------------------------------

interface PendingSave { answer?: string; later?: boolean; attemptId: string }

/** The question a mock was left on, for this tab only: storage that refuses is no loss. */
function readPlace(key: string): string | null {
    try { return window.sessionStorage.getItem(key); } catch { return null; }
}
function writePlace(key: string, value: string) {
    try { window.sessionStorage.setItem(key, value); } catch { /* private mode: open on the first unanswered */ }
}

/** Refusals no retry can change: a bad request, a mock gone or finished, an answer too long. */
const PERMANENT = new Set([400, 404, 409, 413, 422]);

/** A pause on leaving, scheduled per mock and cancelled when the screen mounts again at once. */
const PENDING_PAUSE = new Map<number, number>();

/**
 * Saves answers so none is lost: each change is queued per question and sent
 * with its own attempt id; a failed send stays queued and goes again with the
 * same id (the server writes one id once). Leaving sends what is queued.
 */
function useAnswerSaver(sittingId: number, onSaved: (progress: { answered: number; left: number; later: number }) => void, onRefused: (message: string) => void) {
    const pending = useRef(new Map<number, PendingSave>());
    // The save on its way per question: a flush waits for it rather than
    // reading "not sent" while it is simply still travelling.
    const inflight = useRef(new Map<number, Promise<boolean>>());
    const timers = useRef(new Map<number, number>());
    const [unsaved, setUnsaved] = useState(0);
    // Sends that failed in a row and will be tried again: the save line says
    // "not saved" once there are a few (no connection), not "saving…" forever.
    const [failedInARow, setFailedInARow] = useState(0);
    const savedRef = useRef(onSaved);
    savedRef.current = onSaved;
    const refusedRef = useRef(onRefused);
    refusedRef.current = onRefused;

    const send = useCallback((partId: number): Promise<boolean> => {
        const running = inflight.current.get(partId);
        if (running) return running;
        const p = pending.current.get(partId);
        if (!p) return Promise.resolve(true);
        const trip = api.saveMockAnswer(sittingId, { partId, ...p })
            .then(r => {
                if (pending.current.get(partId) === p) pending.current.delete(partId);
                setFailedInARow(0);
                savedRef.current(r);
                return true;
            })
            .catch((e: { status?: number; message?: string }) => {
                // The server said no for good (a finished mock, an answer too
                // long): sending it again would never succeed and would hold
                // Finish forever. Say so and let it go. A lost connection, a
                // timeout, a busy server or a sign-in that lapsed (401, 403)
                // stay queued and are tried again.
                const status = e?.status ?? 0;
                if (PERMANENT.has(status)) {
                    if (pending.current.get(partId) === p) pending.current.delete(partId);
                    refusedRef.current(e?.message || '');
                    return true;
                }
                setFailedInARow(n => n + 1);
                return false;
            })
            .finally(() => {
                inflight.current.delete(partId);
                setUnsaved(pending.current.size);
                // A change made while this one was on its way goes next.
                const next = pending.current.get(partId);
                if (next && next !== p) void send(partId);
            });
        inflight.current.set(partId, trip);
        return trip;
    }, [sittingId]);

    const queue = useCallback((partId: number, patch: { answer?: string; later?: boolean }, delay = 0) => {
        const prev = pending.current.get(partId);
        pending.current.set(partId, { ...prev, ...patch, attemptId: newAttemptId() });
        setUnsaved(pending.current.size);
        window.clearTimeout(timers.current.get(partId));
        timers.current.set(partId, window.setTimeout(() => { timers.current.delete(partId); void send(partId); }, delay));
    }, [send]);

    /** Send everything queued now; true when all of it is written. */
    const flush = useCallback(async () => {
        for (const id of timers.current.values()) window.clearTimeout(id);
        timers.current.clear();
        await Promise.all([...pending.current.keys()].map(send));
        // One more pass for anything that was in flight and changed meanwhile.
        await Promise.all([...pending.current.keys()].map(send));
        return pending.current.size === 0;
    }, [send]);

    // A failed save is tried again every few seconds.
    useEffect(() => {
        if (!unsaved) return;
        const id = window.setInterval(() => { for (const k of pending.current.keys()) void send(k); }, 5000);
        return () => window.clearInterval(id);
    }, [unsaved, send]);

    // Leaving the page or the screen sends what is still queued.
    useEffect(() => {
        const leave = () => {
            for (const [partId, p] of pending.current) {
                api.saveMockAnswer(sittingId, { partId, ...p }, true).catch(() => {});
            }
        };
        window.addEventListener('pagehide', leave);
        return () => { window.removeEventListener('pagehide', leave); leave(); };
    }, [sittingId]);

    return { queue, flush, unsaved, saving: saveState(unsaved, failedInARow) };
}

export function CourseMockScreen({ detail, onChange, onLeave }: {
    detail: CourseMockDetail;
    onChange: (d: CourseMockDetail) => void;
    /** Back to the mock exams; the answers are written first and the clock stops. */
    onLeave: () => void;
}) {
    const { t } = useTranslation();
    const duration = useDuration();
    const addToast = useStore(s => s.addToast);
    const showConfirm = useStore(s => s.showConfirm);
    const { sitting, course } = detail;
    const questions = course.questions;
    const timed = sitting.timeAllowed > 0;

    // Coming back opens the question the learner was on in this tab; on
    // another device, or a first open, the first one not answered yet.
    const placeKey = `mock-place:${sitting.id}`;
    const [index, setIndex] = useState(() => openingPlace(readPlace(placeKey), questions.map(q => q.answer != null)));
    useEffect(() => { writePlace(placeKey, String(index)); }, [placeKey, index]);
    const [answers, setAnswers] = useState<Record<number, string>>(() => Object.fromEntries(questions.map(q => [q.partId, q.answer ?? ''])));
    const [later, setLater] = useState<Record<number, boolean>>(() => Object.fromEntries(questions.map(q => [q.partId, q.later])));
    const [progress, setProgress] = useState({ answered: course.answered, left: course.left, later: course.later });
    const [listOpen, setListOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [leaving, setLeaving] = useState(false);
    const [finishing, setFinishing] = useState(false);
    const finishId = useRef<string | null>(null);
    const { queue, flush, saving } = useAnswerSaver(sitting.id, setProgress,
        message => addToast('error', message || t("That answer could not be saved.")));

    // Measured on the frame's root, the one element every state shares, so a
    // mock opened paused lays out right once it is resumed.
    const frameRef = useRef<HTMLDivElement>(null);
    const width = useElementWidth(frameRef);
    const rem = useRootFontSize();
    const wide = width >= 40 * rem;

    // On a touch screen with no keyboard attached, typing an answer brings up
    // the on-screen keyboard: the navigation steps aside so the field and the
    // keys keep the room. A desktop keeps it.
    const physicalKeys = usePhysicalKeyboard();
    const [typing, setTyping] = useState(false);

    // The clock, counted on from the server's last reading (as on a past
    // paper), taken in the render that first sees it: a Resume never counts
    // the paused minutes for a frame.
    const base = useMemo(() => ({ elapsed: sitting.elapsed, at: Date.now() }), [sitting]);
    const [, tick] = useState(0);
    useEffect(() => {
        if (!sitting.running || !timed) return;
        const id = window.setInterval(() => tick(n => n + 1), 1000);
        return () => window.clearInterval(id);
    }, [sitting.running, timed]);
    const elapsed = base.elapsed + (sitting.running ? Math.floor((Date.now() - base.at) / 1000) : 0);
    const timeUp = timed && elapsed >= sitting.timeAllowed;

    // Leaving stops the clock; the mock waits in the list with Resume. The
    // pause on unmount waits one tick and a remount cancels it: React's
    // development double mount would otherwise stop a clock just started.
    // A page brought back from the browser's back-forward cache reads the
    // mock again, so a clock the leaving paused shows as paused.
    const sid = sitting.id;
    const changeRef = useRef(onChange);
    changeRef.current = onChange;
    // A mock with no clock is resumed by the screen itself, once per arrival.
    const resumed = useRef(false);
    useEffect(() => {
        window.clearTimeout(PENDING_PAUSE.get(sid));
        PENDING_PAUSE.delete(sid);
        const leave = () => { api.pauseMockOnLeave(sid).catch(() => {}); };
        const back = (e: PageTransitionEvent) => {
            if (!e.persisted) return;
            resumed.current = false;
            api.getMock(sid).then(d => changeRef.current(d as CourseMockDetail)).catch(() => {});
        };
        window.addEventListener('pagehide', leave);
        window.addEventListener('pageshow', back);
        return () => {
            window.removeEventListener('pagehide', leave);
            window.removeEventListener('pageshow', back);
            PENDING_PAUSE.set(sid, window.setTimeout(() => { PENDING_PAUSE.delete(sid); leave(); }, 0));
        };
    }, [sid]);

    const clockAct = useCallback((action: 'pause' | 'resume') => {
        setBusy(true);
        return api.mockClock(sitting.id, action)
            .then(r => onChange({ ...detail, sitting: r.sitting }))
            .catch(e => addToast('error', e.message))
            .finally(() => setBusy(false));
    }, [sitting.id, detail, onChange, addToast]);

    // Coming back to a mock with no clock: nothing to resume by hand.
    useEffect(() => {
        if (!timed && !sitting.running && !resumed.current) { resumed.current = true; void clockAct('resume'); }
    }, [timed, sitting.running, clockAct]);

    const q = questions[Math.min(index, questions.length - 1)];
    const last = index >= questions.length - 1;

    const change = (partId: number, value: string, now = false) => {
        setAnswers(a => ({ ...a, [partId]: value }));
        queue(partId, { answer: value }, now ? 0 : 700);
    };
    const toggleLater = () => {
        const next = !later[q.partId];
        setLater(l => ({ ...l, [q.partId]: next }));
        queue(q.partId, { later: next });
    };
    const go = (i: number) => {
        void flush();
        setIndex(i);
        setListOpen(false);
    };

    const finish = async () => {
        setBusy(true);
        const saved = await flush();
        if (!saved) {
            addToast('error', t("Some answers are not saved yet. Check the connection and try again: nothing is lost."));
            setBusy(false);
            return;
        }
        const open = questions.filter(x => !(answers[x.partId] ?? '').trim()).length;
        if (open > 0) {
            const ok = await showConfirm({
                title: t("Finish the mock?"),
                message: t("{{count}} questions are not answered. They count as zero in the score.", { count: open }),
                confirmLabel: t("Finish"),
                cancelLabel: t("Keep going"),
                variant: 'info',
            });
            if (!ok) { setBusy(false); return; }
        }
        // From here a keystroke would land after the hand-in and be refused:
        // the answer field rests until the finish is written or fails.
        setFinishing(true);
        finishId.current ??= newAttemptId();
        api.finishMock<CourseMockDetail>(sitting.id, { attemptId: finishId.current })
            .then(d => { finishId.current = null; onChange(d); })
            .catch(e => { addToast('error', e.message); setBusy(false); setFinishing(false); });
    };

    const paused = timed && !sitting.running;

    const leave = async () => {
        setLeaving(true);
        if (!(await flush())) {
            addToast('error', t("Some answers are not saved yet. Check the connection and try again: nothing is lost."));
            setLeaving(false);
            return;
        }
        onLeave();
    };

    // The last five minutes are told by weight, not alarm: real exam apps
    // bring the clock forward then, so the learner plans the end.
    const left = sitting.timeAllowed - elapsed;
    const clock = timeUp
        ? t("Time is up")
        : <span className={left <= 300 ? 'font-semibold text-amber-800 dark:text-amber-300' : ''}>{t("{{time}} left", { time: duration(left + 59) })}</span>;
    const status = [
        t("{{answered}} of {{total}} answered", { answered: progress.answered, total: questions.length }),
        timed ? clock : null,
        saving === 'stuck' ? t("not saved yet, check the connection") : saving === 'saving' ? t("saving…") : null,
    ].filter(Boolean)
        // Each part stays whole: at a large text size the line breaks between
        // the count and the clock, never inside either.
        .map((part, i, all) => i < all.length - 1
            ? <Fragment key={i}><span className="whitespace-nowrap">{part} ·</span>{' '}</Fragment>
            : <span key={i} className="whitespace-nowrap">{part}</span>);

    const pauseButton = timed && !paused && !timeUp
        ? (width > 0 && width < EXAM_BAR_TINY * rem
            ? <IconButton size="md" label={t("Pause")} icon={<Pause className="w-5 h-5" />} busy={busy} onClick={() => void clockAct('pause')} />
            : <Button size="sm" busy={busy} icon={<Pause className="w-4 h-4" aria-hidden="true" />} onClick={() => void clockAct('pause')}>{t("Pause")}</Button>)
        : null;

    const frame = (children: React.ReactNode, footer?: React.ReactNode) => (
        <ExamFrame title={t("Mock exam from this course")} status={status} actions={pauseButton}
            onLeave={() => void leave()} leaving={leaving} footer={footer} frameRef={frameRef}>
            {children}
        </ExamFrame>
    );

    if (paused) {
        return frame(
            <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:py-10">
                <Panel>
                    <div className="py-10 text-center">
                        <p className="text-3xl font-semibold text-slate-900 dark:text-white">{t("Paused")}</p>
                        <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
                            {t("{{used}} used of {{allowed}}. The questions are hidden while the clock is stopped.", { used: duration(elapsed), allowed: duration(sitting.timeAllowed) })}
                        </p>
                        <div className="mt-5">
                            <Button variant="primary" busy={busy} icon={<Play className="w-4 h-4" aria-hidden="true" />} onClick={() => void clockAct('resume')}>{t("Resume")}</Button>
                        </div>
                    </div>
                </Panel>
            </div>,
        );
    }

    const items = questions.map(x => ({ answered: !!(answers[x.partId] ?? '').trim(), marked: !!later[x.partId] }));
    const prev = (
        <Button block={!wide} disabled={index === 0} icon={<ChevronLeft className="w-4 h-4" aria-hidden="true" />} onClick={() => go(index - 1)}>
            {t("Previous")}
        </Button>
    );
    const next = last
        ? <Button block={!wide} variant="primary" busy={busy} onClick={() => void finish()}>{t("Finish the mock")}</Button>
        : <Button block={!wide} variant="primary" trailing={<ChevronRight className="w-4 h-4" aria-hidden="true" />} onClick={() => go(index + 1)}>{t("Next")}</Button>;
    const strip = <QuestionStrip items={items} current={index} onGo={go} />;
    const expand = <GridButton onClick={() => setListOpen(true)} />;

    const footer = (
        <div className={`mx-auto w-full max-w-5xl px-2 sm:px-4 ${typing && !physicalKeys ? 'hidden' : ''}`}>
            {wide ? (
                <div className="flex items-center gap-2 py-2">{prev}{strip}{expand}{next}</div>
            ) : (
                <>
                    <div className="flex items-center gap-1 pt-1">{strip}{expand}</div>
                    <div className="flex gap-2 pt-1 pb-2">{prev}{next}</div>
                </>
            )}
        </div>
    );

    return frame(
        <>
            <div className="mx-auto w-full max-w-3xl px-4 py-5 sm:py-8 space-y-4"
                onFocus={e => setTyping(isTextEntry(e.target))} onBlur={() => setTyping(false)}>
                {timeUp && (
                    <div role="status" className="rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-4 py-3 text-sm text-slate-700 dark:text-slate-200">
                        {t("Time is up. Your score is what you answered in time. You can keep answering to practise: those answers are shown apart.")}
                    </div>
                )}
                <Panel>
                    {/* The report flag keeps the card's top-right corner; on a
                        narrow card "Come back to this" wraps under the number. */}
                    <div className="flex items-start gap-2">
                        <div className="flex-1 min-w-0 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                            <p className="whitespace-nowrap text-sm font-medium text-slate-600 dark:text-slate-300 tabular-nums">
                                {t("Question {{n}} of {{total}}", { n: index + 1, total: questions.length })}
                            </p>
                            <Button variant="quiet" size="sm" aria-pressed={!!later[q.partId]} onClick={toggleLater} className="-ml-2.5 whitespace-nowrap"
                                icon={<span aria-hidden="true" className={`w-2.5 h-2.5 rounded-full border-2 border-amber-500 ${later[q.partId] ? 'bg-amber-500' : ''}`} />}>
                                {later[q.partId] ? t("Marked to come back to") : t("Come back to this")}
                            </Button>
                        </div>
                        <ReportItem key={q.partId} itemRef={q.ref} surface="mock" hideKey
                            shown={answers[q.partId] ? { answer: answers[q.partId] } : undefined} />
                    </div>
                    <div className="mt-3 text-base text-slate-900 dark:text-white">
                        <QuestionStem content={q.question.question} surface="mock" media={q.question.media} mediaSize="review" />
                    </div>
                    <div className="mt-4">
                        <AnswerInput key={q.partId} question={q.question} value={answers[q.partId] ?? ''} disabled={finishing || leaving}
                            onChange={v => change(q.partId, v)} onCommit={v => change(q.partId, v, true)} />
                        {formatOf(q.question).hint && (
                            <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{t(formatOf(q.question).hint!)}</p>
                        )}
                    </div>
                </Panel>
            </div>
            {listOpen && (
                <BottomSheet title={t("All questions")} onClose={() => setListOpen(false)}>
                    <div className="px-4 pb-4">
                        <QuestionGrid items={items} current={index} onGo={go} />
                        <div className="mt-5">
                            <Button block busy={busy} onClick={() => { setListOpen(false); void finish(); }}>{t("Finish the mock")}</Button>
                        </div>
                    </div>
                </BottomSheet>
            )}
        </>,
        footer,
    );
}

// ---- the result ------------------------------------------------------------------------

const GROUP_TITLE: Record<ReviewGroup, string> = {
    wrong: k("Wrong"),
    wrong_later: k("Wrong, and marked to come back to"),
    none: k("Not answered"),
    right: k("Right"),
};

export function CourseResultScreen({ detail, onDone }: { detail: CourseMockDetail; onDone: () => void }) {
    const { t } = useTranslation();
    const duration = useDuration();
    const fmt = useNumberFormat();
    const { sitting, result } = detail;
    const date = useMemo(() => new Intl.DateTimeFormat(uiLocale(), { day: 'numeric', month: 'short' }).format(new Date(sitting.startedAt)), [sitting.startedAt]);
    if (!result) return null;
    const groups = (['wrong', 'wrong_later', 'none', 'right'] as const)
        .map(g => ({ g, items: result.review.filter(r => r.group === g) }))
        .filter(x => x.items.length);

    return (
        <div className="space-y-4">
            <div>
                <h2 className="text-lg font-semibold text-slate-900 dark:text-white">{t("Mock exam from this course, {{date}}", { date })}</h2>
                <p className="text-sm text-slate-600 dark:text-slate-300">
                    {sitting.timeAllowed > 0
                        // The clock runs on past the time while late answers are given; the score stops at the time.
                        ? t("Answered on screen in {{used}} of {{allowed}}", { used: duration(Math.min(sitting.elapsed, sitting.timeAllowed)), allowed: duration(sitting.timeAllowed) })
                        : t("Answered on screen in {{used}}, no clock", { used: duration(sitting.elapsed) })}
                </p>
            </div>
            <Panel>
                <p className="text-5xl font-semibold tabular-nums text-slate-900 dark:text-white">
                    {t("{{right}} of {{total}}", { right: fmt(result.right), total: fmt(result.total) })}
                </p>
                <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                    {t("right answers")}
                    {result.notAnswered > 0 && ` · ${t("{{n}} not answered", { n: result.notAnswered })}`}
                </p>
                <div className="mt-4 space-y-2 text-sm text-slate-700 dark:text-slate-200 max-w-prose">
                    {result.passRight != null && result.passed != null && (
                        <p>
                            {result.passed
                                ? result.right === result.passRight
                                    ? t("That is exactly the real exam's pass line of {{pass}} right.", { pass: result.passRight })
                                    : t("That is {{n}} above the real exam's pass line of {{pass}} right.", { n: result.right - result.passRight, pass: result.passRight })
                                : t("That is {{n}} short of the real exam's pass line of {{pass}} right.", { n: result.passRight - result.right, pass: result.passRight })}
                        </p>
                    )}
                    {result.spread && (
                        <p>
                            {t("One mock is a small sample: your real level on these topics is most likely between {{low}} and {{high}} of {{total}} right.", {
                                total: result.total, low: result.spread.low, high: result.spread.high,
                            })}
                        </p>
                    )}
                    {result.notGrade && (
                        <p className="text-slate-600 dark:text-slate-300">
                            {t("This is not a grade. A pass line shows only when the real exam is taken on screen with the same number of questions.")}
                        </p>
                    )}
                    {result.late && (
                        <p className="text-slate-600 dark:text-slate-300">
                            {t("With the answers given after the time ran out: {{right}} right of {{answered}} answered. The score counts what stood when the time ran out.", { right: result.late.right, answered: result.late.answered })}
                        </p>
                    )}
                    {result.reported > 0 && (
                        <p className="text-slate-600 dark:text-slate-300">
                            {t("{{count}} questions you reported as wrong are left out.", { count: result.reported })}
                        </p>
                    )}
                </div>
            </Panel>

            {result.topics.length > 0 && (
                <Panel>
                    <h3 className="text-base font-semibold text-slate-900 dark:text-white">{t("By topic")}</h3>
                    <ul className="mt-2 divide-y divide-slate-200 dark:divide-slate-700">
                        {result.topics.map(tp => (
                            <li key={tp.id} className="py-3">
                                <div className="flex items-baseline gap-x-4">
                                    <span className="flex-1 min-w-0 text-sm text-slate-900 dark:text-white">{tp.title}</span>
                                    <span className="shrink-0 text-right text-sm tabular-nums text-slate-700 dark:text-slate-200">
                                        {t("{{right}} of {{total}}", { right: fmt(tp.right), total: fmt(tp.total) })}
                                    </span>
                                </div>
                                <ProgressBar value={tp.right} max={tp.total} size="sm" className="mt-2" label={tp.title} />
                            </li>
                        ))}
                    </ul>
                    {/* Answers are recorded as practice per topic; a mock never completes or reopens a
                        topic (the mastery check decides that), so the line says what the learner gains. */}
                    <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">
                        {t("Each answer now shows in its topic as practice.")}
                    </p>
                </Panel>
            )}

            <Panel>
                <h3 className="text-base font-semibold text-slate-900 dark:text-white">{t("Your answers")}</h3>
                <div className="mt-3 space-y-6">
                    {groups.map(({ g, items }) => (
                        <section key={g}>
                            <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                                {t(GROUP_TITLE[g])} <span className="font-normal text-slate-500 dark:text-slate-400 tabular-nums">· {fmt(items.length)}</span>
                            </h4>
                            <div className="mt-2 space-y-3">
                                {items.map(r => (
                                    <AnswerReviewItem key={r.partId} question={r.question} answer={r.answer ?? ''} correct={r.correct}
                                        nodeId={r.nodeId ?? 0} nodeTitle={r.correct ? undefined : (r.topic ?? undefined)} projectId={detail.paper.projectId} surface="mock"
                                        badge={<p className="mb-1 text-xs text-slate-500 dark:text-slate-400">{t("Question {{n}}", { n: r.n })}{r.topic ? ` · ${r.topic}` : ''}</p>}
                                        report={<ReportItem itemRef={r.ref} surface="mock" shown={{ answer: r.answer ?? '', correct: r.correct }} listed />} />
                                ))}
                            </div>
                        </section>
                    ))}
                </div>
            </Panel>

            <div className="flex justify-end">
                <Button variant="primary" onClick={onDone}>{t("Done")}</Button>
            </div>
        </div>
    );
}
