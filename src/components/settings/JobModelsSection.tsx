import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
    MessageSquare, BookOpen, ListChecks, ShieldCheck, Image as ImageIcon, Wand2, LifeBuoy, Route, Plus,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useStore } from '../../store';
import { api, AIJobEntry, OllamaModel, SavedConnection } from '../../api';
import { k } from '../../i18n';
import { Button } from '../ui/Button';
import { Select } from '../ui/Select';
import SegmentedControl from '../ui/SegmentedControl';
import { ExpandableSection } from '../ui/Disclosure';
import ModelPicker from '../ModelPicker';
import { SectionHeader, Panel } from './SettingsParts';
import { EFFORT_LABEL, providerOf, sentLevel } from './connections/providers';
import { JOB_IDS, listProblem, freshEntry, sameList, mergeLoaded, acceptSaved } from './jobModels';

/**
 * Settings → AI & Models → which model does each job (server/aiJobs.js).
 *
 * A job runs on the main model until the learner gives it a list of its own;
 * the list is tried in order, the next model only when the one before it
 * fails. The backups are the list behind the main model, for every job that
 * has none. With one connection and nothing chosen, all of this is one line
 * and a button: the default stays simple. The decisions (what may be saved,
 * which answer lands) are in `jobModels.ts`, where the gate runs them.
 */

const JOB_TEXT: Record<typeof JOB_IDS[number], { icon: LucideIcon; title: string; desc: string }> = {
    conversation: { icon: MessageSquare, title: k("Conversation"), desc: k("The assistant, while you wait for its answer.") },
    courses: { icon: BookOpen, title: k("Creating courses"), desc: k("A new course's outline, name and search words, then its lessons, material and the diagrams inside them.") },
    questions: { icon: ListChecks, title: k("Questions and cards"), desc: k("Question banks, quizzes, flashcards, placement checks, and cards from a note you captured.") },
    checks: { icon: ShieldCheck, title: k("Checking answers"), desc: k("A second, independent read of every answer key and lesson before you see it.") },
    vision: { icon: ImageIcon, title: k("Reading pictures"), desc: k("PDF pages that lost their formulas, card pictures, photos of your written work.") },
    small: { icon: Wand2, title: k("Small tasks"), desc: k("Names for regions on the atlas, and other short jobs.") },
};

const hostOfUrl = (url: string) => { try { return new URL(url).host; } catch { return url; } };
const connName = (c: SavedConnection) => (c.kind === 'custom' ? hostOfUrl(c.baseUrl) : providerOf(c.kind).name);
/** Text sent here stays on this machine. */
const onThisComputer = (c: SavedConnection) => {
    if (c.kind === 'ollama') return true;
    try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(c.baseUrl).hostname); } catch { return false; }
};
const effortKey = (id: number, model: string) => `${id}\u0000${model}`;
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export default function JobModelsSection({ active }: { active: boolean }) {
    const { t: tr } = useTranslation();
    const addToast = useStore(s => s.addToast);
    const showConfirm = useStore(s => s.showConfirm);
    const aiConfigRev = useStore(s => s.aiConfigRev);

    const [conns, setConns] = useState<SavedConnection[]>([]);
    const [activeId, setActiveId] = useState<number | null>(null);
    const [backupsName, setBackupsName] = useState('backups');
    const [maxRoute, setMaxRoute] = useState(5);
    // What the server holds, and what is on screen (a list can be mid-edit and
    // not yet savable: a removed connection still in it, a model twice).
    const [saved, setSavedState] = useState<Record<string, AIJobEntry[]>>({});
    const savedRef = useRef(saved);
    const setSaved = (routes: Record<string, AIJobEntry[]>) => { savedRef.current = routes; setSavedState(routes); };
    const [drafts, setDrafts] = useState<Record<string, AIJobEntry[]>>({});
    const [loaded, setLoaded] = useState(false);
    const [opened, setOpened] = useState(false);
    const [models, setModels] = useState<Record<number, { list: OllamaModel[]; loading: boolean }>>({});
    // undefined: not known yet; null: this model publishes no levels.
    const [efforts, setEfforts] = useState<Record<string, string[] | null>>({});
    const askedModels = useRef(new Set<number>());
    const askedEfforts = useRef(new Set<string>());
    // One job's saves run one after another, so the server ends on the last.
    const queues = useRef<Record<string, Promise<void>>>({});
    // A list set aside by "Main model", so "Its own models" brings it back.
    const parked = useRef<Record<string, AIJobEntry[]>>({});

    const load = useCallback(async () => {
        try {
            await Promise.all(Object.values(queues.current));
            const [c, j] = await Promise.all([api.getConnections(), api.getAIJobs()]);
            setConns(c.connections);
            setActiveId(c.activeId);
            setBackupsName(j.backups);
            setMaxRoute(j.maxRoute);
            const before = savedRef.current;
            setSaved(j.routes);
            setDrafts(d => mergeLoaded(before, d, j.routes));
            setLoaded(true);
        } catch { /* the section stays hidden; the model section above says what is wrong */ }
    }, []);
    useEffect(() => {
        if (!active) return;
        // A connection added, removed or re-keyed can change both lists.
        askedModels.current.clear();
        askedEfforts.current.clear();
        setModels({});
        setEfforts({});
        void load();
    }, [active, aiConfigRev, load]);

    const byId = useMemo(() => new Map(conns.map(c => [c.id, c])), [conns]);
    const activeConn = activeId != null ? byId.get(activeId) ?? null : null;

    const loadModels = useCallback((id: number, force = false) => {
        if (askedModels.current.has(id) && !force) return;
        askedModels.current.add(id);
        setModels(m => ({ ...m, [id]: { list: m[id]?.list ?? [], loading: true } }));
        api.getConnectionModels(id)
            .then(r => setModels(n => ({ ...n, [id]: { list: r.models || [], loading: false } })))
            .catch(() => {
                askedModels.current.delete(id);
                setModels(n => ({ ...n, [id]: { list: [], loading: false } }));
            });
    }, []);

    const loadEfforts = useCallback((id: number, model: string) => {
        const key = effortKey(id, model);
        if (askedEfforts.current.has(key)) return;
        askedEfforts.current.add(key);
        api.getEfforts(model || undefined, id)
            .then(r => setEfforts(n => ({ ...n, [key]: r.levels })))
            .catch(() => askedEfforts.current.delete(key));
    }, []);

    const modelOf = (e: AIJobEntry) => e.model || (e.connectionId != null ? byId.get(e.connectionId)?.model ?? '' : '');

    const commit = (job: string, list: AIJobEntry[]) => {
        setDrafts(d => ({ ...d, [job]: list }));
        if (listProblem(list, byId)) return;
        const sent = list.map(e => ({ ...e, model: e.model.trim() }));
        queues.current[job] = (queues.current[job] ?? Promise.resolve()).then(async () => {
            try {
                const r = await api.setAIJob(job, sent);
                setSaved(r.routes);
                setDrafts(d => acceptSaved(d, job, sent, r.routes));
            } catch (err) {
                addToast('error', tr("Could not save this list"), errText(err));
            }
        });
    };

    const anyChosen = Object.values(saved).some(l => l.length > 0);
    if (!active || !loaded || conns.length === 0) return null;

    const problemText = (p: ReturnType<typeof listProblem>) => (p === 'removed'
        ? tr("A connection on this list was removed. Choose another or remove that place.")
        : p === 'duplicate' ? tr("The same model is on this list twice. Choose a different one.") : '');

    const chainText = (list: AIJobEntry[]) => (
        <span className="inline-flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
            {list.map((e, i) => {
                const c = e.connectionId != null ? byId.get(e.connectionId) : undefined;
                return (
                    <span key={i} className="inline-flex flex-wrap items-baseline gap-x-1">
                        {i > 0 && <span aria-hidden="true">→</span>}
                        {c ? (<>
                            <span className="font-medium text-slate-700 dark:text-slate-200 break-all">{modelOf(e) || tr("its saved model")}</span>
                            <span>· {connName(c)}{onThisComputer(c) ? ` · ${tr("this computer")}` : ''}</span>
                        </>) : (
                            <span className="text-red-700 dark:text-red-300">{tr("a removed connection")}</span>
                        )}
                    </span>
                );
            })}
        </span>
    );
    const mainModel = activeConn?.model ?? '';
    const mainText = <span>{tr("Main model")}{mainModel ? ` · ${mainModel}` : ''}</span>;

    // One connection and nothing chosen: one line and a button.
    if (!opened && !anyChosen && conns.length < 2) {
        return (
            <section className="mb-8">
                <SectionHeader title={tr("Which model does each job")} icon={Route}>
                    {tr("Every job uses the main model.")}
                </SectionHeader>
                <Panel>
                    <p className="text-sm text-slate-500 dark:text-slate-400 mb-3">
                        {tr("You can give some jobs another model, for example a cheaper one for work that runs in the background, and add backups that are tried when a model fails. Nothing changes until you choose one.")}
                    </p>
                    <Button onClick={() => setOpened(true)}>{tr("Choose models per job")}</Button>
                </Panel>
            </section>
        );
    }

    const editor = (job: string, jobTitle: string, list: AIJobEntry[], backups: boolean) => {
        const problem = problemText(listProblem(list, byId));
        // The first place on this computer followed by one that is not: the
        // learner should know a failure sends the text elsewhere.
        let leaves: SavedConnection | null = null;
        for (let i = 1; i < list.length && !leaves; i++) {
            const prev = list.slice(0, i).map(e => (e.connectionId != null ? byId.get(e.connectionId) : undefined));
            const here = list[i].connectionId != null ? byId.get(list[i].connectionId!) : undefined;
            if (here && !onThisComputer(here) && prev.some(c => c && onThisComputer(c))) leaves = here;
        }
        const move = (i: number, d: number) => {
            const next = [...list];
            [next[i], next[i + d]] = [next[i + d], next[i]];
            commit(job, next);
        };
        const patch = (i: number, p: Partial<AIJobEntry>) => commit(job, list.map((e, n) => (n === i ? { ...e, ...p } : e)));
        const add = () => {
            const entry = freshEntry(list, conns, byId);
            if (entry.connectionId != null) loadModels(entry.connectionId);
            commit(job, [...list, entry]);
        };
        return (
            <div className="space-y-3">
                <ol className="space-y-3">
                    {list.map((e, i) => {
                        const c = e.connectionId != null ? byId.get(e.connectionId) : undefined;
                        const model = modelOf(e);
                        const at = { n: i + 1, job: jobTitle };
                        const heading = backups
                            ? (i === 0 ? tr("First backup") : tr("If that fails"))
                            : (i === 0 ? tr("First choice") : tr("If that fails"));
                        return (
                            <li key={i} className="rounded-lg border border-slate-200 dark:border-slate-700 p-3 space-y-2">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                    <span className="text-sm font-medium text-slate-700 dark:text-slate-200">{i + 1}. {heading}</span>
                                    <span className="flex gap-1.5">
                                        <Button size="sm" variant="quiet" disabled={i === 0} onClick={() => move(i, -1)} aria-label={tr("Move place {{n}} of {{job}} up", at)}>{tr("Up")}</Button>
                                        <Button size="sm" variant="quiet" disabled={i === list.length - 1} onClick={() => move(i, 1)} aria-label={tr("Move place {{n}} of {{job}} down", at)}>{tr("Down")}</Button>
                                        <Button size="sm" variant="quiet" onClick={() => commit(job, list.filter((_, n) => n !== i))} aria-label={tr("Remove place {{n}} from {{job}}", at)}>{tr("Remove")}</Button>
                                    </span>
                                </div>
                                <div className="grid gap-2 grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))]">
                                    <Select
                                        aria-label={tr("Connection for place {{n}} of {{job}}", at)}
                                        value={e.connectionId ?? ''}
                                        onChange={v => patch(i, { connectionId: Number(v), model: '', effort: '' })}
                                    >
                                        {e.connectionId == null && <option value="" disabled>{tr("Removed connection: choose another")}</option>}
                                        {conns.map(o => (
                                            <option key={o.id} value={o.id}>
                                                {onThisComputer(o) ? tr("{{name}} · this computer", { name: connName(o) }) : connName(o)}
                                            </option>
                                        ))}
                                    </Select>
                                    {c && (
                                        <div onFocusCapture={() => loadModels(c.id)} onPointerDownCapture={() => loadModels(c.id)}>
                                            <ModelPicker
                                                label={tr("Model for place {{n}} of {{job}}", at)}
                                                value={e.model}
                                                // A level belongs to a model: a new model starts on automatic.
                                                onChange={m => patch(i, { model: m, effort: '' })}
                                                models={models[c.id]?.list ?? []}
                                                loading={models[c.id]?.loading}
                                                onRefresh={() => loadModels(c.id, true)}
                                                inherit={{ label: tr("Its saved model"), detail: c.model || undefined }}
                                                placeholder={tr("Choose or type a model id")}
                                            />
                                        </div>
                                    )}
                                </div>
                                {c && <EffortRow
                                    connectionId={c.id}
                                    model={model}
                                    levels={efforts[effortKey(c.id, model)]}
                                    ask={loadEfforts}
                                    value={e.effort}
                                    label={tr("Reasoning level for place {{n}} of {{job}}", at)}
                                    onChange={v => patch(i, { effort: v })}
                                />}
                            </li>
                        );
                    })}
                </ol>
                <div role="alert">
                    {problem && <p className="text-sm text-red-700 dark:text-red-300">{problem}</p>}
                </div>
                {leaves && (
                    <p className="rounded-lg px-3 py-2 text-sm bg-amber-50 text-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
                        {tr("If the model on this computer fails, this job's text goes to {{name}}.", { name: connName(leaves) })}
                    </p>
                )}
                <Button icon={<Plus className="w-4 h-4" aria-hidden="true" />} disabled={list.length >= maxRoute} onClick={add}>
                    {backups ? tr("Add a backup model") : tr("Add a backup")}
                </Button>
                <p className="text-sm text-slate-500 dark:text-slate-400">
                    {tr("The next model is tried when the one before it is busy (after three tries), down, out of credit, refuses the key or does not have that model. Never after you stop it or after part of an answer arrived. Every new request starts again at the first choice.")}
                </p>
            </div>
        );
    };

    const resetAll = async () => {
        const ok = await showConfirm({
            title: tr("Use the main model for every job"),
            message: tr("Every job goes back to the main model, and the backups are removed."),
            confirmLabel: tr("Use the main model"),
        });
        if (!ok) return;
        try {
            await Promise.all(Object.values(queues.current));
            const r = await api.clearAIJobs();
            parked.current = {};
            setSaved(r.routes);
            setDrafts(r.routes);
        } catch (err) {
            addToast('error', tr("Could not change the jobs"), errText(err));
        }
    };

    const chooseMode = (job: string, own: boolean) => {
        const list = drafts[job] ?? [];
        if (own) {
            commit(job, parked.current[job] ?? [{ connectionId: activeConn?.id ?? conns[0].id, model: '', effort: '' }]);
            delete parked.current[job];
        } else {
            if (list.length) parked.current[job] = list;
            commit(job, []);
        }
    };

    const backupList = drafts[backupsName] ?? [];
    return (
        <section className="mb-8">
            <SectionHeader title={tr("Which model does each job")} icon={Route}>
                {tr("A job uses the main model unless you give it its own. Its own list is tried in order: the next model only when the one before it fails.")}
            </SectionHeader>
            <Panel flush className="divide-y divide-slate-200 dark:divide-slate-700">
                {JOB_IDS.map(id => {
                    const text = JOB_TEXT[id];
                    const title = tr(text.title);
                    const list = drafts[id] ?? [];
                    const was = saved[id] ?? [];
                    const own = list.length > 0;
                    const stopped = was.length > 0 && was.every(e => e.connectionId == null);
                    const unsaved = !sameList(list, was);
                    return (
                        <ExpandableSection
                            key={id}
                            variant="row"
                            icon={text.icon}
                            title={title}
                            desc={<>
                                {tr(text.desc)}
                                <span className="mt-1 block">
                                    {stopped
                                        ? <span className="text-red-700 dark:text-red-300">{tr("Stopped: its connection was removed. Choose another.")}</span>
                                        : was.length ? chainText(was) : mainText}
                                    {unsaved && <span className="ml-1.5 text-amber-700 dark:text-amber-300">{tr("Changes not saved yet")}</span>}
                                </span>
                            </>}
                        >
                            <div className="space-y-3">
                                <SegmentedControl
                                    label={tr("Which model does {{job}}", { job: title })}
                                    value={own ? 'own' : 'main'}
                                    options={[
                                        { value: 'main', label: tr("Main model") },
                                        { value: 'own', label: tr("Its own models") },
                                    ]}
                                    onChange={v => chooseMode(id, v === 'own')}
                                />
                                {own
                                    ? editor(id, title, list, false)
                                    : parked.current[id] && (
                                        <p className="text-sm text-slate-500 dark:text-slate-400">
                                            {tr("Its own list is kept until you leave Settings: choose Its own models to bring it back.")}
                                        </p>
                                    )}
                            </div>
                        </ExpandableSection>
                    );
                })}
            </Panel>

            <div className="mt-6">
                <SectionHeader title={tr("If the main model fails")} icon={LifeBuoy}>
                    {tr("Tried in order for every job that uses the main model. A job with its own list uses only that list.")}
                </SectionHeader>
                <Panel>
                    {backupList.length === 0 ? (
                        <div className="space-y-3">
                            <p className="text-sm text-slate-500 dark:text-slate-400">
                                {tr("None yet. Without one, a job that fails says so and you can try again.")}
                            </p>
                            <Button
                                icon={<Plus className="w-4 h-4" aria-hidden="true" />}
                                onClick={() => commit(backupsName, [freshEntry([], conns, byId)])}
                            >
                                {tr("Add a backup model")}
                            </Button>
                        </div>
                    ) : editor(backupsName, tr("the backups"), backupList, true)}
                </Panel>
            </div>

            {anyChosen && (
                <div className="mt-4">
                    <Button onClick={() => void resetAll()}>{tr("Use the main model for every job again…")}</Button>
                </div>
            )}
        </section>
    );
}

/** The reasoning level of one place, offered only when its model has levels. */
function EffortRow({ connectionId, model, levels, ask, value, label, onChange }: {
    connectionId: number;
    model: string;
    levels: string[] | null | undefined;
    ask: (id: number, model: string) => void;
    value: string;
    label: string;
    onChange: (v: string) => void;
}) {
    const { t: tr } = useTranslation();
    useEffect(() => { ask(connectionId, model); }, [ask, connectionId, model]);
    if (!levels?.length) return null;
    const shown = value ? sentLevel(value, levels) : '';
    return (
        <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-slate-500 dark:text-slate-400" aria-hidden="true">{tr("Reasoning level")}</span>
            <Select fit size="sm" aria-label={label} value={shown} onChange={onChange}>
                <option value="">{tr("Automatic")}</option>
                {levels.map(l => <option key={l} value={l}>{tr(EFFORT_LABEL[l] ?? l)}</option>)}
            </Select>
        </div>
    );
}
