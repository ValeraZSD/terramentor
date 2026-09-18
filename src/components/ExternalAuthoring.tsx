import { useState, useEffect, useCallback } from 'react';
import { Copy, Check, Loader2, ArrowRight, AlertTriangle, BookOpen } from 'lucide-react';
import { api } from '../api';
import { useStore } from '../store';
import { copyText } from '../utils/clipboard';
import { usePointerVerb } from '../utils/platform';
import { TextInput, Select } from './ui/Field';
import { Button } from './ui/Button';
import { AuthoringPhase, MaterialMergeResult, OutlineBriefFields } from '../types';
import { useTranslation } from 'react-i18next';
import { k } from '../i18n';

/**
 * Writing a course with a chat model the learner already has open.
 *
 * TWO PASSES, and the reason is measured rather than stylistic — see the header
 * of `server/authoringBrief.js`. Pass one asks for the tree; pass two fills one
 * phase with real teaching. The UI's whole job is to make the second pass feel
 * like a normal, repeatable thing rather than a recovery procedure, because a
 * course only gets good if the learner comes back and deepens it.
 *
 * The prompt is shown, not hidden behind a button that copies it invisibly: it
 * is going into someone else's chat under their account, and they are entitled
 * to read what it says first.
 */

/* ------------------------------------------------------------------ *
 * Shared pieces
 * ------------------------------------------------------------------ */

const STEP = 'flex items-center justify-center w-6 h-6 rounded-full bg-accent text-white text-xs font-semibold shrink-0';

function Step({ n, title, children }: { n: number; title: string; children?: React.ReactNode }) {
    return (
        <div className="flex gap-3">
            <div className={STEP} aria-hidden="true">{n}</div>
            <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-slate-800 dark:text-slate-100 mb-2">{title}</p>
                {children}
            </div>
        </div>
    );
}

/**
 * The prompt itself, with the copy button that is the point of the screen.
 *
 * The button is full-width and 44px tall rather than a small icon in the corner:
 * it is the one control on this panel that everything else exists to lead to,
 * and on a phone a corner icon over a scrolling code block is a miss waiting to
 * happen.
 */
function PromptBox({ prompt, loading }: { prompt: string; loading: boolean }) {
    const { t: tr } = useTranslation();
    const [copied, setCopied] = useState(false);
    const addToast = useStore(s => s.addToast);

    // A prompt that changed under a "Copied" tick has not been copied.
    useEffect(() => { setCopied(false); }, [prompt]);

    const handleCopy = async () => {
        const ok = await copyText(prompt);
        if (!ok) {
            addToast('error', tr("Could not reach the clipboard"), tr("Select the text below and copy it by hand."));
            return;
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    if (loading) {
        return (
            <div className="flex items-center gap-2 h-32 justify-center text-sm text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-700 rounded-xl">
                <Loader2 className="w-4 h-4 animate-spin" /> {tr("Preparing the prompt…")}
            </div>
        );
    }

    return (
        <div className="space-y-2">
            <Button
                variant="primary"
                size="lg"
                block
                onClick={handleCopy}
                disabled={!prompt}
                icon={copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                // The confirmed state is the one colour a control may set from
                // outside the vocabulary: it is a verdict, not a variant.
                className={copied ? 'bg-emerald-700 text-white can-hover:hover:bg-emerald-700' : undefined}
            >
                {copied ? tr("Copied — now paste it into the chat") : tr("Copy the prompt")}
            </Button>
            <details className="group">
                <summary className="text-sm text-slate-500 dark:text-slate-400 cursor-pointer min-h-[44px] flex items-center hover:text-slate-700 dark:hover:text-slate-200">
                    {tr("Read it first (")}{prompt ? Math.round(prompt.length / 1000) : 0}{tr("k characters)")}
                </summary>
                <pre className="mt-2 max-h-64 overflow-auto text-[11px] leading-relaxed whitespace-pre-wrap break-words bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl p-3 text-slate-600 dark:text-slate-300">
                    {prompt}
                </pre>
            </details>
        </div>
    );
}

/**
 * Where the model's reply comes back in.
 *
 * A textarea rather than a file drop, because a chat reply is copied, not
 * downloaded — asking someone to save a message to disk first adds a step for
 * no gain. The Import tab still takes files for everything that arrives as one.
 */
function ReplyBox({
    label, placeholder, busy, error, onSubmit,
}: {
    label: string;
    placeholder: string;
    busy: boolean;
    error: string;
    onSubmit: (parsed: unknown) => void;
}) {
    const { t: tr } = useTranslation();
    const [text, setText] = useState('');
    const [parseError, setParseError] = useState('');
    const verb = usePointerVerb();

    const submit = () => {
        setParseError('');
        const trimmed = text.trim()
            // Models fence their JSON however often you ask them not to.
            .replace(/^```(?:json)?\s*/i, '')
            .replace(/```\s*$/, '')
            .trim();
        if (!trimmed) { setParseError('Paste the reply first.'); return; }
        let parsed: unknown;
        try {
            parsed = JSON.parse(trimmed);
        } catch (e) {
            // The most common cause by far is a reply that ran out of budget
            // mid-object, and saying so is more use than the parser's offset.
            setParseError(
                `That is not valid JSON (${(e as Error).message}). If the reply was cut off, ask the chat to continue and paste the whole thing.`,
            );
            return;
        }
        onSubmit(parsed);
    };

    return (
        <div className="space-y-2">
            <textarea
                value={text}
                onChange={e => setText(e.target.value)}
                placeholder={placeholder}
                rows={4}
                spellCheck={false}
                aria-label={label}
                className="w-full px-4 py-2.5 text-base font-mono rounded-xl border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-white focus:ring-2 focus:ring-accent focus:border-accent resize-none"
            />
            {(parseError || error) && (
                <p className="text-sm text-red-600 dark:text-red-400 flex items-start gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    <span>{parseError || error}</span>
                </p>
            )}
            <Button
                variant="primary"
                size="lg"
                block
                onClick={submit}
                busy={busy}
                disabled={!text.trim()}
                trailing={busy ? undefined : <ArrowRight className="w-4 h-4" />}
            >
                {busy ? tr("Reading it…") : `${verb === 'Tap' ? tr("Tap") : tr("Click")} ${tr("to add it")}`}
            </Button>
        </div>
    );
}

/* ------------------------------------------------------------------ *
 * Pass one — inside the create-project modal
 * ------------------------------------------------------------------ */

/**
 * `k()` so the extractor sees them: these were three bare sentences rendered
 * straight into `<option>`, which meant the one select on this screen stayed
 * English in every language.
 *
 * The ENGLISH stays the value and only the label is translated. The choice goes
 * into the brief this panel hands to an outside model, and that brief is
 * English (`server/briefs/outline.md`) — translating the value would put one
 * Dutch phrase inside an English instruction.
 */
const DEPTHS = [
    k('a 2-week primer'),
    k('a semester course'),
    k('everything there is'),
];

export function OutlineBriefPanel({
    subject, setSubject, language, onImported,
}: {
    subject: string;
    setSubject: (v: string) => void;
    /** The modal's language selection, so the two tabs cannot disagree. */
    language: string;
    onImported: (projectId: number, name: string) => void;
}) {
    const { t: tr } = useTranslation();
    const [level, setLevel] = useState('');
    const [goal, setGoal] = useState('');
    const [depth, setDepth] = useState(DEPTHS[1]);
    const [prompt, setPrompt] = useState('');
    const [loading, setLoading] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    // The outline that just landed. The panel stays open on it rather than
    // closing: pass two is the same gesture with the same chat still open, and
    // a learner sent to an empty dashboard with a toast telling them to "add
    // the teaching material" has no idea where that lives.
    const [created, setCreated] = useState<{ id: number; name: string } | null>(null);
    const addToast = useStore(s => s.addToast);

    // Rebuilt as the brief is typed, debounced — the prompt on screen must be
    // the prompt the button copies, and a stale one is a silently wrong course.
    useEffect(() => {
        const fields: OutlineBriefFields = { subject, level, goal, depth, language };
        let cancelled = false;
        setLoading(true);
        const t = setTimeout(() => {
            api.outlineBrief(fields)
                .then(r => { if (!cancelled) setPrompt(r.prompt); })
                .catch(() => { if (!cancelled) setPrompt(''); })
                .finally(() => { if (!cancelled) setLoading(false); });
        }, 300);
        return () => { cancelled = true; clearTimeout(t); };
    }, [subject, level, goal, depth, language]);

    const handleReply = async (parsed: unknown) => {
        setBusy(true);
        setError('');
        try {
            const project = await api.importProject(parsed as never);
            const warnings = (project as { warnings?: string[] }).warnings || [];
            // The grid, the workspace header and the dashboard all read the
            // store's project list — every other creation path refreshes it
            // (`createProject`), and this one did not, so opening the new
            // project landed on a titleless header over "No Data Available".
            await useStore.getState().loadProjects();
            addToast(
                warnings.length ? 'info' : 'success',
                tr("Imported \"{{name}}\"", { name: project.name }),
                warnings.length ? warnings.join(' ') : undefined,
            );
            setCreated({ id: project.id, name: project.name });
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setBusy(false);
        }
    };

    // The outline is a skeleton — titles and one short overview each. Handing
    // the learner straight to the project hides the half that makes it a
    // course, so the second pass is offered here, where the chat that wrote
    // the outline is still open. Leaving is one button and costs nothing:
    // every phase can be written later from the project's ⋮ menu.
    if (created) {
        return (
            <div className="space-y-5">
                <div className="rounded-xl border border-emerald-200 dark:border-emerald-800/50 bg-emerald-50 dark:bg-emerald-900/15 p-3">
                    <p className="text-sm font-medium text-emerald-800 dark:text-emerald-200 flex items-center gap-2">
                        <Check className="w-4 h-4 shrink-0" aria-hidden="true" />
                        {tr("“{{name}}” is in your library", { name: created.name })}
                    </p>
                    <p className="mt-1 text-sm text-emerald-700/90 dark:text-emerald-300/90 leading-relaxed">
                        {tr("That was the outline: every topic has a title and a short overview. The teaching itself is written one phase at a time — do the first phase now, or open the project and come back to this whenever you like.")}
                    </p>
                </div>

                <MaterialPassPanel projectId={created.id} />

                <div className="pt-1 border-t border-slate-200 dark:border-slate-700 space-y-2">
                    <Button
                        variant="primary"
                        size="lg"
                        block
                        onClick={() => onImported(created.id, created.name)}
                        trailing={<ArrowRight className="w-4 h-4" />}
                    >
                        {tr("Open the project")}
                    </Button>
                    <p className="text-sm text-slate-500 dark:text-slate-400 text-center">
                        {tr("You can come back to this screen from the project's dashboard, under “Add teaching material”.")}
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-5">
            <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed">
                {tr("A chat model writes the course; this app teaches it. Nothing is sent from here — you paste the prompt into whatever chat you already use, and bring the reply back.")}
            </p>

            <Step n={1} title={tr("Describe the course")}>
                <div className="space-y-2">
                    {/* The same primitives ProjectFormFields uses — these sit on
                        the same dialog as the "With AI" tab, and two input heights
                        on one modal reads as a bug. A copied class string keeps
                        them in step by coincidence; the shared component is the
                        fix. */}
                    <TextInput
                        value={subject}
                        onChange={e => setSubject(e.target.value)}
                        placeholder={tr("Subject — e.g. Wave optics, Japanese N3, control theory")}
                        aria-label={tr("Subject")}
                    />
                    <TextInput
                        value={level}
                        onChange={e => setLevel(e.target.value)}
                        placeholder={tr("What you already know (sets the floor)")}
                        aria-label={tr("What you already know")}
                    />
                    <TextInput
                        value={goal}
                        onChange={e => setGoal(e.target.value)}
                        placeholder={tr("What it is for — an exam, a project, a deadline")}
                        aria-label={tr("What it is for")}
                    />
                    <Select value={depth} onChange={e => setDepth(e.target.value)} aria-label={tr("Depth")}>
                        {DEPTHS.map(d => <option key={d} value={d}>{tr(d)}</option>)}
                    </Select>
                </div>
            </Step>

            <Step n={2} title={tr("Paste it into a chat with web search on")}>
                <PromptBox prompt={prompt} loading={loading} />
            </Step>

            <Step n={3} title={tr("Paste the reply back")}>
                <ReplyBox
                    label={tr("The model's reply")}
                    placeholder={tr("{ \"project\": { … }, \"nodes\": [ … ] }")}
                    busy={busy}
                    error={error}
                    onSubmit={handleReply}
                />
            </Step>
        </div>
    );
}

/* ------------------------------------------------------------------ *
 * Pass two — deepening one phase of a project that already exists
 * ------------------------------------------------------------------ */

export function MaterialPassPanel({ projectId }: { projectId: number }) {
    const { t: tr } = useTranslation();
    const [phases, setPhases] = useState<AuthoringPhase[] | null>(null);
    const [phaseId, setPhaseId] = useState<number | null>(null);
    const [prompt, setPrompt] = useState('');
    const [leafCount, setLeafCount] = useState(0);
    const [loading, setLoading] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [result, setResult] = useState<MaterialMergeResult | null>(null);
    // Bumped after a merge so the brief is re-fetched: the phase row updates to
    // "2/2 written" while the step beside it still offered a prompt for topics
    // that now have their material — two counts of the same thing, disagreeing.
    const [merged, setMerged] = useState(0);
    const addToast = useStore(s => s.addToast);

    const loadPhases = useCallback(() => {
        api.authoringPhases(projectId)
            .then(r => {
                setPhases(r.phases);
                // Open on the first phase that still needs work, which is the
                // one the learner came here for.
                setPhaseId(prev => prev ?? (r.phases.find(p => p.withMaterial < p.leaves) || r.phases[0])?.id ?? null);
            })
            .catch(e => setError((e as Error).message));
    }, [projectId]);

    useEffect(loadPhases, [loadPhases]);

    useEffect(() => {
        if (phaseId == null) return;
        let cancelled = false;
        setLoading(true);
        api.materialBrief(projectId, phaseId)
            .then(r => { if (!cancelled) { setPrompt(r.prompt); setLeafCount(r.leaves); } })
            .catch(() => { if (!cancelled) setPrompt(''); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [projectId, phaseId, merged]);

    const handleReply = async (parsed: unknown) => {
        setBusy(true);
        setError('');
        setResult(null);
        try {
            const r = await api.mergeMaterial(projectId, parsed);
            setResult(r);
            addToast('success', tr("Added {{count}} readings", { count: r.added }),
                r.unmatched.length ? tr("{{count}} topics did not match — see the list.", { count: r.unmatched.length }) : undefined);
            loadPhases();
            setMerged(n => n + 1);
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setBusy(false);
        }
    };

    if (!phases) {
        return <div className="flex items-center gap-2 py-8 justify-center text-sm text-slate-500 dark:text-slate-400"><Loader2 className="w-4 h-4 animate-spin" /> {tr("Loading…")}</div>;
    }
    if (!phases.length) {
        return <p className="py-6 text-sm text-slate-500 dark:text-slate-400">{tr("This project has no phases to write material for yet.")}</p>;
    }

    const done = phases.every(p => p.withMaterial >= p.leaves);

    return (
        <div className="space-y-5">
            <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed">
                {tr("One phase per reply. A chat model cannot write a whole course's teaching in one go. Come back and do the next phase whenever you like.")}
            </p>

            <Step n={1} title={tr("Pick a phase")}>
                <div className="space-y-1.5">
                    {phases.map(p => {
                        const complete = p.leaves > 0 && p.withMaterial >= p.leaves;
                        const selected = p.id === phaseId;
                        return (
                            <button
                                key={p.id}
                                type="button"
                                onClick={() => { setPhaseId(p.id); setResult(null); }}
                                aria-pressed={selected}
                                data-row="phase"
                                className={`w-full min-h-[44px] px-3 py-2 rounded-xl text-left flex items-center gap-3 border transition ${selected
                                    ? 'border-accent bg-accent/10'
                                    : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800'
                                    }`}
                            >
                                <BookOpen className={`w-4 h-4 shrink-0 ${complete ? 'text-emerald-500' : 'text-slate-400'}`} />
                                <span className="flex-1 min-w-0 text-sm text-slate-800 dark:text-slate-100 truncate">{p.title}</span>
                                <span className={`text-sm shrink-0 ${complete ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-500 dark:text-slate-400'}`}>
                                    {tr("{{withMaterial}}/{{leaves}} written", { withMaterial: p.withMaterial, leaves: p.leaves })}
                                </span>
                            </button>
                        );
                    })}
                </div>
                {done && (
                    <p className="mt-2 text-sm text-emerald-600 dark:text-emerald-400">
                        {tr("Every topic in this project already has material. Picking a phase again will report it rather than overwrite it.")}
                    </p>
                )}
            </Step>

            <Step n={2} title={leafCount ? tr("Paste it into a chat — {{count}} topics still to write", { count: leafCount }) : tr("Paste it into a chat")}>
                <PromptBox prompt={prompt} loading={loading} />
            </Step>

            <Step n={3} title={tr("Paste the reply back")}>
                <ReplyBox
                    label={tr("The model's reply")}
                    placeholder={tr("{ \"leaves\": [ { \"title\": \"…\", \"overview\": \"…\" } ] }")}
                    busy={busy}
                    error={error}
                    onSubmit={handleReply}
                />
            </Step>

            {result && (
                <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-3 space-y-2">
                    <p className="text-sm font-medium text-slate-800 dark:text-slate-100">
                        {tr("Added {{added}} readings to {{topics}} topics.", { count: result.added, added: result.added, topics: result.topics.length })}
                    </p>
                    {/* An unmatched topic is the one thing worth acting on, so it is
                        listed rather than counted — the usual cause is the model
                        rewording a title it was told to echo. */}
                    {result.unmatched.length > 0 && (
                        <div>
                            <p className="text-sm font-medium text-amber-600 dark:text-amber-400 mb-1">
                                {tr("Not added ({{length}}):", { length: result.unmatched.length })}
                            </p>
                            <ul className="text-sm text-slate-600 dark:text-slate-300 space-y-0.5 max-h-32 overflow-auto">
                                {result.unmatched.map((u, i) => (
                                    <li key={i}>“{u.title}” — {u.reason}</li>
                                ))}
                            </ul>
                        </div>
                    )}
                    {result.warnings.map((w, i) => (
                        <p key={i} className="text-sm text-slate-500 dark:text-slate-400">{w}</p>
                    ))}
                </div>
            )}
        </div>
    );
}
