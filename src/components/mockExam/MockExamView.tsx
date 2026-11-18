import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, FileText, Plus, Timer, Trash2 } from 'lucide-react';
import { api } from '../../api';
import { useStore } from '../../store';
import { Button, ButtonLink, IconButton } from '../ui/Button';
import { SegmentedControl } from '../ui/SegmentedControl';
import { Select } from '../ui/Select';
import { useNumberFormat } from '../../hooks/useNumberFormat';
import { uiLocale } from '../../utils/locale';
import AddPaperDialog from './AddPaperDialog';
import MockSittingScreen from './MockSittingScreen';
import { CourseStartPanel } from './CourseMock';
import { Panel } from './Panel';
import type { CourseListSitting, MockExamList, MockListSitting } from './mockExamTypes';
import { useDuration } from './mockFormat';
import { runningSittings } from './courseMockState';

/**
 * Mock exam: a real past paper, written by hand with the app as the clock,
 * then marked part by part against the worked solution (server/mockExams.js);
 * or a draw from the course's own questions, answered on screen (CourseMock).
 *
 * One screen, three moments: pick a paper and start; the sitting itself
 * (clock, marking, result: MockSittingScreen); and the earlier mocks. A mock
 * left half-way stays in the list with Resume, so leaving never loses it.
 */
export default function MockExamView({ projectId }: { projectId: number }) {
    const { t } = useTranslation();
    const addToast = useStore(s => s.addToast);
    const [data, setData] = useState<MockExamList | null>(null);
    const [failed, setFailed] = useState(false);
    const [open, setOpen] = useState<number | null>(null);
    const [adding, setAdding] = useState(false);
    const [source, setSource] = useState<'course' | 'paper' | null>(null);

    const load = useCallback(() => {
        api.getMockExams(projectId)
            .then(d => { setData(d); setFailed(false); })
            .catch(() => setFailed(true));
    }, [projectId]);
    useEffect(() => { load(); }, [load]);

    // Closing the tab or the app pauses every running clock, whether the
    // learner is on its clock screen or back on this list; it waits there with
    // Resume. Going Back from a past paper's clock inside the app does not
    // pause: the time runs on as it would at the exam (a course mock pauses
    // when its screen closes, CourseMock.tsx). The server ignores a pause once
    // the writing is over.
    const running = useRef<number[]>([]);
    useEffect(() => { running.current = runningSittings(data, open); }, [data, open]);
    useEffect(() => {
        const leave = () => { for (const id of running.current) void api.pauseMockOnLeave(id).catch(() => {}); };
        window.addEventListener('pagehide', leave);
        return () => window.removeEventListener('pagehide', leave);
    }, []);

    // Stable, so the sitting screen's own load does not re-run on every render.
    const closeSitting = useCallback(() => { setOpen(null); load(); }, [load]);

    if (open != null) {
        return <MockSittingScreen sittingId={open} onClose={closeSitting} />;
    }

    // Where the questions come from, until chosen: the course when its real
    // exam is on screen, the past papers when it is on paper, else whichever exists.
    const exam = data?.course.exam;
    const from = source ?? (exam ? (exam.onScreen ? 'course' : 'paper') : data && data.papers.length > 0 ? 'paper' : 'course');

    return (
        <div className="flex-1 overflow-auto">
            <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:py-8 space-y-4">
                <div className="flex flex-wrap items-center gap-3">
                    <h2 className="flex-1 min-w-0 text-lg font-semibold text-slate-900 dark:text-white">{t("Mock exam")}</h2>
                    {data && (
                        <SegmentedControl label={t("Questions from")} value={from} onChange={setSource}
                            options={[
                                { value: 'course', label: t("This course") },
                                { value: 'paper', label: t("A past paper") },
                            ]} />
                    )}
                </div>
                {data && from === 'paper' && data.papers.length > 0 && (
                    <div className="flex justify-end -mt-2">
                        <Button variant="quiet" size="sm" icon={<Plus className="w-4 h-4" aria-hidden="true" />} onClick={() => setAdding(true)}>
                            {t("Add a past paper")}
                        </Button>
                    </div>
                )}

                {failed && (
                    <Panel>
                        <p className="text-sm text-slate-700 dark:text-slate-300">{t("The mock exams could not be loaded.")}</p>
                        <div className="mt-3"><Button onClick={load}>{t("Try again")}</Button></div>
                    </Panel>
                )}
                {!data && !failed && <Panel><div className="h-24" aria-busy="true" /></Panel>}

                {data && from === 'course' && (
                    <CourseStartPanel projectId={projectId} course={data.course} onStarted={setOpen} onChanged={load} />
                )}

                {data && from === 'paper' && data.papers.length === 0 && (
                    <Panel>
                        <h3 className="text-base font-semibold text-slate-900 dark:text-white">{t("Practise with a past paper")}</h3>
                        <p className="mt-2 text-sm text-slate-600 dark:text-slate-300 max-w-prose">
                            {t("Add an old exam paper and its worked solution from this course's files, with the points per question. You write it by hand with the app as the clock, then grade it yourself against the solution.")}
                        </p>
                        <div className="mt-4">
                            <Button variant="primary" icon={<Plus className="w-4 h-4" aria-hidden="true" />} onClick={() => setAdding(true)}>
                                {t("Add a past paper")}
                            </Button>
                        </div>
                    </Panel>
                )}

                {data && from === 'paper' && data.papers.length > 0 && (
                    // Keyed on the paper count: a paper just added becomes the one picked.
                    <StartPanel key={data.papers.length} data={data} onStarted={setOpen} onError={(m) => addToast('error', m)} />
                )}

                {data && <EarlierMocks data={data} onOpen={setOpen} onChanged={load} />}
            </div>

            {adding && data && (
                <AddPaperDialog
                    projectId={projectId}
                    topics={data.topics}
                    documents={data.documents}
                    onClose={() => setAdding(false)}
                    onAdded={() => { setAdding(false); load(); }}
                />
            )}
        </div>
    );
}

function StartPanel({ data, onStarted, onError }: {
    data: MockExamList;
    onStarted: (id: number) => void;
    onError: (message: string) => void;
}) {
    const { t } = useTranslation();
    const duration = useDuration();
    const [paperId, setPaperId] = useState(data.papers[data.papers.length - 1].id);
    const paper = data.papers.find(p => p.id === paperId) ?? data.papers[0];
    const questions = useMemo(() => [...new Set(paper.parts.map(p => p.question))], [paper]);
    const [length, setLength] = useState<'paper' | 'question'>('paper');
    const [question, setQuestion] = useState(questions[0]);
    const [busy, setBusy] = useState(false);
    // Back to the first question only when another paper is picked, never on a
    // reload of the same paper (which replaces every object in `data`).
    useEffect(() => { setQuestion(questions[0]); }, [paper.id]); // eslint-disable-line react-hooks/exhaustive-deps

    const qPoints = paper.parts.filter(p => p.question === question).reduce((a, p) => a + p.points, 0);
    const seconds = length === 'paper' ? paper.minutes * 60 : Math.ceil(paper.minutes * qPoints / paper.total) * 60;

    const start = () => {
        setBusy(true);
        api.startMock(paper.id, length === 'question' ? question : null)
            .then(r => onStarted(r.sitting.id))
            .catch(e => onError(e.message))
            .finally(() => setBusy(false));
    };

    return (
        <Panel>
            <h3 className="text-base font-semibold text-slate-900 dark:text-white">{t("This mock exam")}</h3>
            <div className="mt-2 divide-y divide-slate-200 dark:divide-slate-700">
                <Row label={t("Paper")}>
                    {data.papers.length > 1 ? (
                        <Select value={String(paper.id)} onChange={v => setPaperId(Number(v))} aria-label={t("Paper")}>
                            {data.papers.map(p => <option key={p.id} value={String(p.id)}>{p.title}</option>)}
                        </Select>
                    ) : <span className="text-sm text-slate-900 dark:text-white">{paper.title}</span>}
                </Row>
                <Row label={t("Length")}>
                    <SegmentedControl
                        label={t("Length")}
                        value={length}
                        onChange={setLength}
                        options={[
                            { value: 'question', label: t("One question") },
                            { value: 'paper', label: t("Whole paper") },
                        ]}
                    />
                </Row>
                {length === 'question' && (
                    <Row label={t("Question")}>
                        <Select value={question} onChange={v => setQuestion(String(v))} aria-label={t("Question")}>
                            {questions.map(q => <option key={q} value={q}>{t("Question {{q}}", { q })}</option>)}
                        </Select>
                    </Row>
                )}
                <Row label={t("Exam clock")}>
                    <span className="text-sm tabular-nums text-slate-900 dark:text-white">{duration(seconds)}</span>
                </Row>
            </div>
            <p className="mt-4 rounded-xl bg-slate-100 dark:bg-slate-900/60 px-4 py-3 text-sm text-slate-700 dark:text-slate-300">
                {t("Print the paper or open it on a second screen, and write on paper as you will on the day. The app keeps the clock. Afterwards you grade it against the worked solution.")}
            </p>
            <div className="mt-4 flex flex-wrap justify-end gap-2">
                {paper.paperDocumentId != null && (
                    <ButtonLink href={api.documentOriginalUrl(paper.paperDocumentId)} target="_blank" rel="noopener" icon={<FileText className="w-4 h-4" aria-hidden="true" />}>
                        {t("Open the paper")}
                    </ButtonLink>
                )}
                <Button variant="primary" busy={busy} icon={<Timer className="w-4 h-4" aria-hidden="true" />} onClick={start}>
                    {t("Start the clock")}
                </Button>
            </div>
        </Panel>
    );
}

export function Row({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3 min-h-[3.5rem]">
            <span className="text-sm font-medium text-slate-700 dark:text-slate-200">{label}</span>
            <div>{children}</div>
        </div>
    );
}

function EarlierMocks({ data, onOpen, onChanged }: { data: MockExamList; onOpen: (id: number) => void; onChanged: () => void }) {
    const { t } = useTranslation();
    const fmt = useNumberFormat();
    const addToast = useStore(s => s.addToast);
    const showConfirm = useStore(s => s.showConfirm);
    const rows = useMemo(() => [
        ...data.papers.flatMap(p => p.sittings.map(s => ({ s: s as MockListSitting | CourseListSitting, title: p.title }))),
        ...data.courseSittings.map(s => ({ s: s as MockListSitting | CourseListSitting, title: t("From this course") })),
    ].sort((a, b) => b.s.startedAt.localeCompare(a.s.startedAt)), [data, t]);
    const dateFmt = useMemo(() => new Intl.DateTimeFormat(uiLocale(), { day: 'numeric', month: 'short' }), []);
    if (rows.length === 0) return null;

    const outcome = (s: MockListSitting | CourseListSitting) => {
        if (s.status !== 'done') return t("Not finished");
        if ('source' in s) return t("{{right}} of {{total}} right", { right: fmt(s.right ?? 0), total: fmt(s.total) });
        if (s.grade != null) return t("grade {{grade}}", { grade: fmt(s.grade, { decimals: 1 }) });
        return t("{{earned}} of {{total}} points", { earned: fmt(s.earned), total: fmt(s.total) });
    };
    const discard = async (s: MockListSitting | CourseListSitting) => {
        const id = s.id;
        const ok = await showConfirm({
            title: t("Discard this mock?"),
            message: 'source' in s
                ? t("Its answers and time are deleted. A new mock draws its questions again.")
                : t("Its time and any points you gave are deleted. The paper stays."),
            confirmLabel: t("Discard"),
            variant: 'danger',
        });
        if (!ok) return;
        api.discardMock(id).then(onChanged).catch(e => addToast('error', e.message));
    };
    const pending = (s: MockListSitting | CourseListSitting) => {
        if (s.status === 'marking') return t("Grade it");
        if (s.timeUp) return t("Time is up");
        return s.running ? t("Clock running") : t("Resume");
    };

    return (
        <Panel>
            <h3 className="text-base font-semibold text-slate-900 dark:text-white">{t("Earlier mock exams")}</h3>
            <ul className="mt-2 divide-y divide-slate-200 dark:divide-slate-700">
                {rows.map(({ s, title }) => (
                    <li key={s.id} className="flex items-center gap-2">
                        <button
                            type="button"
                            data-row
                            onClick={() => onOpen(s.id)}
                            className="flex-1 min-w-0 flex items-center gap-3 py-3 text-left rounded-lg hover:bg-slate-50 dark:hover:bg-slate-700/40"
                        >
                            <span className="flex-1 min-w-0 text-sm text-slate-900 dark:text-white">
                                {dateFmt.format(new Date(s.startedAt))}
                                <span className="text-slate-500 dark:text-slate-400"> · {title}{s.question ? ` · ${t("Question {{q}}", { q: s.question })}` : ''}</span>
                            </span>
                            <span className="shrink-0 text-sm tabular-nums text-slate-700 dark:text-slate-200">
                                {s.status === 'done' ? outcome(s) : pending(s)}
                            </span>
                            <ChevronRight className="w-4 h-4 shrink-0 text-slate-400" aria-hidden="true" />
                        </button>
                        {s.status !== 'done' && (
                            <IconButton size="sm" label={t("Discard this mock")} icon={<Trash2 className="w-4 h-4" />} onClick={() => discard(s)} />
                        )}
                    </li>
                ))}
            </ul>
        </Panel>
    );
}
