import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
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
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const total = parts.reduce((a, p) => a + p.points, 0);
    const edit = (key: number, patch: Partial<PartDraft>) => setParts(ps => ps.map(p => (p.key === key ? { ...p, ...patch } : p)));
    const add = (next: typeof nextPart) => setParts(ps => [...ps, next(ps[ps.length - 1], Math.max(...ps.map(x => x.key)) + 1)]);

    const save = () => {
        setBusy(true);
        setError(null);
        api.addExamPaper(projectId, {
            title, minutes, gradeMin, gradeMax, passGrade,
            paperDocumentId: paperDoc, solutionDocumentId: solutionDoc,
            parts: parts.map(({ question, part, points, nodeId }) => ({ question, part, points, nodeId })),
        })
            .then(onAdded)
            .catch(e => setError(e.message))
            .finally(() => setBusy(false));
    };

    const docSelect = (id: string, value: number | null, set: (v: number | null) => void) => (
        <Select id={id} value={value == null ? '' : String(value)} onChange={v => set(v === '' ? null : Number(v))}>
            <option value="">{t("None")}</option>
            {documents.map(d => <option key={d.id} value={String(d.id)}>{d.title}</option>)}
        </Select>
    );

    return (
        <Modal
            isOpen
            onClose={onClose}
            title={t("Add a past paper")}
            maxWidth="max-w-2xl"
            footer={(
                <>
                    <Button onClick={onClose}>{t("Cancel")}</Button>
                    <Button variant="primary" busy={busy} disabled={!title.trim()} onClick={save}>{t("Add the paper")}</Button>
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
                    <Field label={t("The paper")}>{id => docSelect(id, paperDoc, setPaperDoc)}</Field>
                    <Field label={t("Worked solution")}>{id => docSelect(id, solutionDoc, setSolutionDoc)}</Field>
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
                </div>
                {error && <p role="alert" className="text-sm text-amber-800 dark:text-amber-300">{error}</p>}
            </div>
        </Modal>
    );
}
