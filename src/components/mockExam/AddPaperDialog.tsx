import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Plus, Trash2, Upload } from 'lucide-react';
import Modal from '../Modal';
import { Button, IconButton } from '../ui/Button';
import { Field, TextInput } from '../ui/Field';
import { Select } from '../ui/Select';
import Stepper from '../ui/Stepper';
import { api } from '../../api';
import { useNumberFormat } from '../../hooks/useNumberFormat';
import type { MockExamList } from './mockExamTypes';

interface PartDraft { key: number; question: string; part: string; points: number; nodeId: number | null }

/** The part after `last`: the next letter of the same question, else the next question. */
function nextPart(last: PartDraft | undefined, key: number): PartDraft {
    if (!last) return { key, question: '1', part: '', points: 10, nodeId: null };
    if (/^[a-y]$/.test(last.part)) {
        return { key, question: last.question, part: String.fromCharCode(last.part.charCodeAt(0) + 1), points: last.points, nodeId: last.nodeId };
    }
    return nextQuestion(last, key);
}

/** The first part of the question after `last`'s. */
function nextQuestion(last: PartDraft | undefined, key: number): PartDraft {
    if (!last) return { key, question: '1', part: '', points: 10, nodeId: null };
    const n = Number(last.question);
    return { key, question: Number.isInteger(n) ? String(n + 1) : '', part: '', points: last.points, nodeId: null };
}

/**
 * Add a past paper: its name, the time allowed, the grade formula printed on
 * its cover, the paper and worked solution from the course's own files, and
 * the points per question and part, each tagged to the topic it tests.
 */
export default function AddPaperDialog({ projectId, topics, documents, onClose, onAdded }: {
    projectId: number;
    topics: MockExamList['topics'];
    documents: MockExamList['documents'];
    onClose: () => void;
    onAdded: () => void;
}) {
    const { t } = useTranslation();
    const fmt = useNumberFormat();
    const [title, setTitle] = useState('');
    const [minutes, setMinutes] = useState(180);
    const [gradeMin, setGradeMin] = useState(1);
    const [gradeMax, setGradeMax] = useState(10);
    const [passGrade, setPassGrade] = useState(5.5);
    const [paperDoc, setPaperDoc] = useState<number | null>(null);
    const [solutionDoc, setSolutionDoc] = useState<number | null>(null);
    const [parts, setParts] = useState<PartDraft[]>([{ key: 0, question: '1', part: 'a', points: 8, nodeId: null }]);
    const [printed, setPrinted] = useState('');
    const [docs, setDocs] = useState(documents);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const total = parts.reduce((a, p) => a + p.points, 0);
    // The total printed on the paper, when typed, checks the table: a
    // mistyped row shows here before the paper is added, not in a grade.
    const printedTotal = /^\d+$/.test(printed.trim()) ? Number(printed.trim()) : null;
    // Typed but not a whole number ("80 pts", "80,5"): said so, never skipped silently.
    const printedBad = printed.trim() !== '' && printedTotal == null;
    const mismatch = printedTotal != null && printedTotal !== total;
    // An upload still running holds Add, so the paper is never saved without its file.
    const [uploading, setUploading] = useState(0);
    const onBusy = (on: boolean) => setUploading(n => n + (on ? 1 : -1));
    const edit = (key: number, patch: Partial<PartDraft>) => setParts(ps => ps.map(p => (p.key === key ? { ...p, ...patch } : p)));
    const add = (next: typeof nextPart) => setParts(ps => [...ps, next(ps[ps.length - 1], Math.max(...ps.map(x => x.key)) + 1)]);

    const save = () => {
        setBusy(true);
        setError(null);
        api.addExamPaper(projectId, {
            title, minutes, gradeMin, gradeMax, passGrade,
            paperDocumentId: paperDoc, solutionDocumentId: solutionDoc, printedTotal,
            parts: parts.map(({ question, part, points, nodeId }) => ({ question, part, points, nodeId })),
        })
            .then(onAdded)
            .catch(e => setError(e.message))
            .finally(() => setBusy(false));
    };

    const docSelect = (id: string, uploadLabel: string, value: number | null, set: (v: number | null) => void) => (
        <div className="flex gap-2">
            <div className="flex-1 min-w-0">
                <Select id={id} value={value == null ? '' : String(value)} onChange={v => set(v === '' ? null : Number(v))}>
                    <option value="">{t("None")}</option>
                    {docs.map(d => <option key={d.id} value={String(d.id)}>{d.title}</option>)}
                </Select>
            </div>
            <UploadButton projectId={projectId} label={uploadLabel} onError={setError} onBusy={onBusy}
                onUploaded={doc => { setDocs(ds => [...ds, doc]); set(doc.id); }} />
        </div>
    );

    return (
        <Modal
            isOpen
            onClose={onClose}
            title={t("Add a past paper")}
            maxWidth="max-w-2xl"
            footer={(
                <>
                    {!title.trim() && (
                        <span className="min-w-[12rem] flex-1 text-sm text-slate-500 dark:text-slate-400">{t("Give the paper a name to add it.")}</span>
                    )}
                    {/* One group, so a narrow footer wraps both buttons under the line, never one of them. */}
                    <div className="ml-auto flex gap-2">
                        <Button onClick={onClose}>{t("Cancel")}</Button>
                        <Button variant="primary" busy={busy} disabled={!title.trim() || mismatch || printedBad || uploading > 0} onClick={save}>{t("Add the paper")}</Button>
                    </div>
                </>
            )}
        >
            <div className="space-y-5">
                <Field label={t("Name")}>
                    {id => <TextInput id={id} value={title} onChange={e => setTitle(e.target.value)} placeholder={t("Sample exam 19")} />}
                </Field>
                <div>
                    <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(9rem,1fr))]">
                        <Field label={t("Minutes allowed")}>
                            {id => <Stepper id={id} value={minutes} min={5} max={600} step={5} onChange={setMinutes} label={t("Minutes allowed")} />}
                        </Field>
                        <Field label={t("Lowest grade")}>
                            {id => <Stepper id={id} value={gradeMin} min={0} max={gradeMax - 0.5} step={0.5} onChange={setGradeMin} label={t("Lowest grade")} />}
                        </Field>
                        <Field label={t("Highest grade")}>
                            {id => <Stepper id={id} value={gradeMax} min={gradeMin + 0.5} max={100} step={0.5} onChange={setGradeMax} label={t("Highest grade")} />}
                        </Field>
                        <Field label={t("Pass grade")}>
                            {id => <Stepper id={id} value={passGrade} min={gradeMin} max={gradeMax} step={0.5} onChange={setPassGrade} label={t("Pass grade")} />}
                        </Field>
                    </div>
                    <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                        {t("As printed on the paper's cover: grade = points / total × {{span}} + {{min}}, from {{min}} to {{max}}.", {
                            span: fmt(gradeMax - gradeMin), min: fmt(gradeMin), max: fmt(gradeMax),
                        })}
                    </p>
                </div>
                <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(11rem,1fr))]">
                    <Field label={t("The paper")}>{id => docSelect(id, t("Upload the paper"), paperDoc, setPaperDoc)}</Field>
                    <Field label={t("Worked solution")}>{id => docSelect(id, t("Upload the worked solution"), solutionDoc, setSolutionDoc)}</Field>
                </div>

                <div>
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-white">{t("Questions and points")}</h3>
                    <ul className="mt-2 space-y-2">
                        {parts.map(p => (
                            <li key={p.key} className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 dark:border-slate-700 p-2">
                                <TextInput aria-label={t("Question")} value={p.question} onChange={e => edit(p.key, { question: e.target.value })} className="!w-16 text-center" />
                                <TextInput aria-label={t("Part")} value={p.part} onChange={e => edit(p.key, { part: e.target.value })} className="!w-14 text-center" placeholder="a" />
                                <Stepper value={p.points} min={1} max={100} onChange={v => edit(p.key, { points: Math.max(1, Math.round(v)) })} label={t("Points")} className="w-32" />
                                <div className="flex-1 min-w-[10rem]">
                                    <Select value={p.nodeId == null ? '' : String(p.nodeId)} onChange={v => edit(p.key, { nodeId: v === '' ? null : Number(v) })} aria-label={t("Topic")}>
                                        <option value="">{t("No topic")}</option>
                                        {topics.map(tp => <option key={tp.id} value={String(tp.id)}>{tp.title}</option>)}
                                    </Select>
                                </div>
                                <IconButton label={t("Remove")} icon={<Trash2 className="w-4 h-4" />} disabled={parts.length === 1}
                                    onClick={() => setParts(ps => ps.filter(x => x.key !== p.key))} />
                            </li>
                        ))}
                    </ul>
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
                        <div className="flex flex-wrap gap-2">
                            <Button variant="quiet" icon={<Plus className="w-4 h-4" aria-hidden="true" />} onClick={() => add(nextQuestion)}>
                                {t("Add a question")}
                            </Button>
                            <Button variant="quiet" icon={<Plus className="w-4 h-4" aria-hidden="true" />} onClick={() => add(nextPart)}>
                                {t("Add a part")}
                            </Button>
                        </div>
                        <span className="text-sm tabular-nums text-slate-600 dark:text-slate-300">{t("{{count}} points in total", { count: total })}</span>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                        <label htmlFor="paper-printed-total" className="text-sm text-slate-700 dark:text-slate-200">{t("Total printed on the paper")}</label>
                        <TextInput id="paper-printed-total" inputMode="numeric" value={printed} onChange={e => setPrinted(e.target.value)}
                            className="!w-20 text-center tabular-nums" aria-describedby="paper-printed-check" />
                        <p id="paper-printed-check" aria-live="polite"
                            className={`flex items-center gap-1.5 text-sm ${mismatch || printedBad ? 'text-amber-800 dark:text-amber-300' : 'text-slate-600 dark:text-slate-300'}`}>
                            {printedBad ? t("Type the total as a whole number of points.") : printedTotal == null ? null : mismatch ? (
                                total < printedTotal
                                    ? t("{{count}} points are still missing from the questions above.", { count: printedTotal - total })
                                    : t("The questions above have {{count}} points too many.", { count: total - printedTotal })
                            ) : (
                                <><Check className="w-4 h-4" aria-hidden="true" />{t("The questions above add up to this total.")}</>
                            )}
                        </p>
                    </div>
                </div>
                {error && <p role="alert" className="text-sm text-amber-800 dark:text-amber-300">{error}</p>}
            </div>
        </Modal>
    );
}

/**
 * The kinds a browser shows by itself, which the server takes as a paper or its
 * solution (server/mockExams.js SHOWN_KINDS). Checked on the file's name BEFORE
 * the upload, since an uploaded file stays in the course's files.
 */
const PAPER_KINDS = ['pdf', 'jpg', 'jpeg', 'png', 'webp'];
const paperKind = (name: string) => PAPER_KINDS.includes(name.split('.').pop()?.toLowerCase() ?? '');

/**
 * Upload the paper or its worked solution from here, into the course's own
 * files, and pick it for the field it was uploaded from: no trip to the
 * course's files and back with the dialog half filled.
 */
function UploadButton({ projectId, label, onUploaded, onError, onBusy }: {
    projectId: number;
    /** The button's full name ("Upload the paper"): two sit in the dialog, both reading "Upload". */
    label: string;
    onUploaded: (doc: MockExamList['documents'][number]) => void;
    onError: (message: string | null) => void;
    onBusy: (busy: boolean) => void;
}) {
    const { t } = useTranslation();
    const input = useRef<HTMLInputElement>(null);
    const [busy, setBusy] = useState(false);
    const working = (on: boolean) => { setBusy(on); onBusy(on); };
    const pick = (file: File | undefined) => {
        if (!file) return;
        onError(null);
        const clear = () => { if (input.current) input.current.value = ''; };
        if (!paperKind(file.name)) {
            onError(t("Upload a PDF or a picture: those open in the browser beside your points."));
            clear();
            return;
        }
        working(true);
        api.uploadDocumentFiles([file], { projectId })
            .then(({ documents: [doc] }) => {
                if (!doc?.ok) throw new Error(doc?.error || t("That file could not be read."));
                if (!PAPER_KINDS.includes(doc.file_type ?? '')) throw new Error(t("Upload a PDF or a picture: those open in the browser beside your points."));
                onUploaded({ id: doc.id, title: doc.title, fileType: doc.file_type! });
            })
            .catch(e => onError(e.message))
            .finally(() => { working(false); clear(); });
    };
    return (
        <>
            <input ref={input} type="file" accept=".pdf,image/png,image/jpeg,image/webp" className="sr-only" tabIndex={-1} aria-hidden="true"
                onChange={e => pick(e.target.files?.[0])} />
            <Button busy={busy} aria-label={label} icon={<Upload className="w-4 h-4" aria-hidden="true" />} onClick={() => input.current?.click()}>
                {t("Upload")}
            </Button>
        </>
    );
}
