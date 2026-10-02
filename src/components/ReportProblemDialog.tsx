import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bug, X, Copy, Check, ExternalLink, Lightbulb, MessageSquareWarning, Info } from 'lucide-react';
import { useStore } from '../store';
import {
    diagnosticsBlock, reportText, reportUrl, REPORT_FORMS, REPORT_KINDS,
    type ReportDraft, type ReportKind,
} from '../utils/report';
import { copyText } from '../utils/clipboard';
import { holdReload } from '../utils/freshness';
import { useTranslation } from 'react-i18next';
import Radio from './ui/Radio';
import { Button, ButtonLink, IconButton } from './ui/Button';
import { Field, TextArea, TextInput } from './ui/Field';
import { useTapGuard } from '../hooks/useTapGuard';
import { usePortalAccent } from '../hooks/usePortalAccent';
import { useDialogFocus } from '../hooks/useDialogFocus';
import { k } from '../i18n';

/**
 * "Report a problem" — the in-app front end to the issue tracker.
 *
 * The problem this solves is not that filing an issue is hard; it is that the
 * half of an issue that makes it actionable (which build, which commit, which
 * model, Docker or not) is invisible to the person filing it. The app knows all
 * of that. So it fills that half in, and the person writes the half they are the
 * only expert in — here, in the app, in the same fields the GitHub form has
 * (`REPORT_FORMS` in utils/report.ts, asserted field by field against
 * `.github/ISSUE_TEMPLATE/*.yml` by tools/report-gates.mjs).
 *
 * SHOW, DON'T SEND. What the fields hold is what the link carries, and the
 * machine report is printed in full under them. "Continue on GitHub" opens
 * GitHub's own compose form with all of it filled in — this app makes no
 * request, and GitHub receives the text when the person presses Submit on
 * GitHub's page. Anyone who does not want to open a browser at all can press
 * Copy report and paste it wherever they like.
 *
 * The same dialog opens from the assistant: when a learner explains in plain
 * words what went wrong, the assistant drafts a ```report block and its preview
 * opens this, filled in (`prefill`), for them to read, edit and send.
 *
 * Three kinds rather than one, because the third is specific to this project:
 * a learner who cannot read a stack trace is perfectly placed to notice that a
 * generated lesson taught something false, and CONTRIBUTING.md already calls
 * that one of the most valuable reports there is. A single "Bug" form would bury
 * it under fields about reproduction steps that do not apply.
 */

/** A growing box's height while EMPTY, from the rows its field asks for, so the
 *  main question still opens as the biggest box. Literal classes for Tailwind. */
const EMPTY_HEIGHT: Record<number, string> = { 2: 'min-h-16', 3: 'min-h-20', 4: 'min-h-28' };

const KINDS: Record<ReportKind, { hint: string; Icon: typeof Bug }> = {
    bug: { hint: k("A button does nothing, a page is wrong, an error appears."), Icon: Bug },
    content: { hint: k("A lesson, question, visual or grade that is factually wrong."), Icon: MessageSquareWarning },
    idea: { hint: k("Something missing, or something that could work better."), Icon: Lightbulb },
};

/** What the person has typed, per kind, so switching kinds loses nothing. */
interface DraftState {
    kind: ReportKind;
    title: string;
    values: Record<ReportKind, Record<string, string>>;
}

/**
 * Drafts by `draftKey`, for the life of the page. A dialog closed by a stray tap
 * on the backdrop comes back as it was left; an assistant's draft reopened from
 * its preview shows the learner's edits, not the model's original.
 */
const drafts = new Map<string, DraftState>();

const emptyValues = (): DraftState['values'] => ({ bug: {}, content: {}, idea: {} });

function initialState(key: string | undefined, prefill: ReportDraft | null | undefined): DraftState {
    const kept = key ? drafts.get(key) : undefined;
    if (kept) return kept;
    const values = emptyValues();
    if (prefill) values[prefill.kind] = { ...prefill.fields };
    return { kind: prefill?.kind ?? 'bug', title: prefill?.title ?? '', values };
}

export interface ReportProblemDialogProps {
    open: boolean;
    onClose: () => void;
    /** A draft someone else wrote — the assistant's ```report block. */
    prefill?: ReportDraft | null;
    /** Keeps what was typed across a close and a reopen. */
    draftKey?: string;
    /** The person pressed Continue on GitHub. */
    onOpened?: () => void;
}

export default function ReportProblemDialog(props: ReportProblemDialogProps) {
    // The body mounts per opening, so its state starts from the saved draft or
    // the prefill every time rather than from whatever the last opening left.
    if (!props.open) return null;
    return <ReportDialogBody {...props} />;
}

function ReportDialogBody({ onClose, prefill, draftKey = 'settings', onOpened }: ReportProblemDialogProps) {
    const { t } = useTranslation();
    const version = useStore(s => s.appVersion);
    const aiProvider = useStore(s => s.aiProvider);
    const aiModel = useStore(s => s.aiModel);
    const [state, setState] = useState<DraftState>(() => initialState(draftKey, prefill));
    const [copied, setCopied] = useState(false);
    const panelRef = useRef<HTMLDivElement>(null);
    const { anchor, accent } = usePortalAccent(true);
    // A backdrop TAP closes, never the end of a drag that lifted over it — a
    // selection dragged out of a field would otherwise throw the report away.
    const backdrop = useTapGuard(onClose, true);

    useEffect(() => { drafts.set(draftKey, state); }, [draftKey, state]);

    // Not a moment to reload onto a new build. `canReloadNow` spares only a
    // FOCUSED field with text in it, and a report being read has none: the
    // assistant's draft opens with focus on the dialog itself, and the learner
    // comes back from checking something in another tab (a focus event, which
    // is when freshness re-asks) with focus on a radio or a button. A reload
    // there throws the whole report away; the update banner waits instead.
    useEffect(() => holdReload('report-dialog'), []);

    // `Modal`'s contract. Escape closes THIS dialog and nothing under it: the
    // assistant overlay it can open over is on the same dialog stack, so only
    // the topmost answers. Focus lands on the dialog, not on a field, even with
    // a keyboard: an assistant's draft arrives filled in and is read first.
    useDialogFocus(true, panelRef, {
        initialFocus: panelRef,
        onEscape: (e) => { e.preventDefault(); e.stopPropagation(); onClose(); },
    });

    const form = REPORT_FORMS[state.kind];
    const ctx = { version, aiProvider, aiModel };
    const draft: ReportDraft = { kind: state.kind, title: state.title, fields: state.values[state.kind] };
    const repo = version?.repoUrl || 'https://github.com/ValeraZSD/terramentor';
    const { url, shortened } = useMemo(
        () => reportUrl(repo, draft, ctx),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [repo, state, version, aiProvider, aiModel],
    );
    const hasEnvironment = form.fields.some(f => f.auto === 'environment');
    const block = hasEnvironment ? diagnosticsBlock(ctx) : '';

    const setField = (id: string, value: string) => setState(s => ({
        ...s, values: { ...s.values, [s.kind]: { ...s.values[s.kind], [id]: value } },
    }));

    const copy = async () => {
        // `navigator.clipboard` is undefined over plain http, which is how a
        // phone reaches this without a tunnel; `copyText` falls back to the
        // execCommand path there. When even that fails every field is on screen
        // and selectable, so say nothing rather than flash a tick.
        if (!await copyText(reportText(draft, ctx))) return;
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    };

    const opened = () => {
        onOpened?.();
        // A report typed from Settings has gone to GitHub; the next one starts
        // empty. An assistant's draft stays with its turn, edits and all.
        if (draftKey === 'settings') drafts.delete(draftKey);
        onClose();
    };

    return (
        <>
            <span ref={anchor} className="hidden" aria-hidden="true" />
            {createPortal(
                <div
                    className="fixed inset-0 z-[60] flex items-end justify-center p-0 sm:items-center sm:p-4"
                    style={accent}
                    role="presentation"
                >
                    <div className="absolute inset-0 bg-black/50" {...backdrop} aria-hidden="true" />
                    <div
                        ref={panelRef}
                        tabIndex={-1}
                        className="relative flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-white shadow-xl outline-none dark:bg-slate-800 sm:rounded-2xl"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="report-dialog-title"
                    >
                        <div className="flex items-start gap-3 border-b border-slate-200 p-4 dark:border-slate-700">
                            <Bug className="mt-0.5 h-5 w-5 shrink-0 text-accent-fg" aria-hidden="true" />
                            <div className="min-w-0 flex-1">
                                <h2 id="report-dialog-title" className="font-semibold text-slate-900 dark:text-white">{t("Report a problem")}</h2>
                                <p className="text-sm text-slate-500 dark:text-slate-400">
                                    {t("Nothing is sent from here — this opens a form you fill in and submit yourself.")}
                                </p>
                            </div>
                            <IconButton size="sm" label={t("Close")} icon={<X className="h-4 w-4" aria-hidden="true" />} onClick={onClose} />
                        </div>

                        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
                            <fieldset>
                                <legend className="mb-2 text-sm font-medium text-slate-900 dark:text-white">
                                    {t("What are you reporting?")}
                                </legend>
                                <div className="space-y-2">
                                    {REPORT_KINDS.map(id => {
                                        const { hint, Icon } = KINDS[id];
                                        const on = state.kind === id;
                                        return (
                                            <label
                                                key={id}
                                                className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition ${on
                                                    ? 'border-accent bg-accent/10'
                                                    : 'border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-700/50'}`}
                                            >
                                                <Radio
                                                    name="report-kind"
                                                    value={id}
                                                    checked={on}
                                                    onChange={() => setState(s => ({ ...s, kind: id }))}
                                                    className="mt-0.5"
                                                />
                                                <Icon className="mt-0.5 h-4 w-4 shrink-0 text-slate-500 dark:text-slate-400" aria-hidden="true" />
                                                <span className="min-w-0">
                                                    <span className="block text-sm font-medium text-slate-900 dark:text-white">{t(REPORT_FORMS[id].name)}</span>
                                                    <span className="block text-sm text-slate-500 dark:text-slate-400">{t(hint)}</span>
                                                </span>
                                            </label>
                                        );
                                    })}
                                </div>
                            </fieldset>

                            <Field label={t("Title")} help={t("One line that says what it is about.")}>
                                {id => (
                                    <TextInput
                                        id={id}
                                        value={state.title}
                                        maxLength={200}
                                        onChange={e => setState(s => ({ ...s, title: e.target.value }))}
                                    />
                                )}
                            </Field>

                            {form.fields.filter(f => !f.auto).map(f => (
                                <Field
                                    key={`${state.kind}:${f.id}`}
                                    label={f.required ? t(f.label) : (
                                        <>{t(f.label)} <span className="font-normal text-slate-500 dark:text-slate-400">{t("(optional)")}</span></>
                                    )}
                                    help={f.help ? t(f.help) : undefined}
                                >
                                    {id => f.type === 'input' ? (
                                        <TextInput id={id} value={draft.fields[f.id] ?? ''} onChange={e => setField(f.id, e.target.value)} />
                                    ) : (
                                        <TextArea
                                            id={id}
                                            rows={f.rows ?? 3}
                                            value={draft.fields[f.id] ?? ''}
                                            onChange={e => setField(f.id, e.target.value)}
                                            // A draft is here to be READ: a box that
                                            // grows with its text shows all of it,
                                            // where a fixed one hid the end of the
                                            // assistant's answer behind an inner
                                            // scroll on a phone. Capped, so one long
                                            // answer cannot push the rest off screen;
                                            // browsers without field-sizing keep rows.
                                            className={`resize-y [field-sizing:content] max-h-72 ${EMPTY_HEIGHT[f.rows ?? 3] ?? 'min-h-20'}`}
                                        />
                                    )}
                                </Field>
                            ))}

                            <p className="flex items-start gap-2 text-sm text-slate-500 dark:text-slate-400">
                                <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                                {t(form.githubAsks)}
                            </p>

                            {hasEnvironment && (
                                <div>
                                    <h3 className="text-sm font-medium text-slate-900 dark:text-white">
                                        {t("These details go with it")}
                                    </h3>
                                    <p className="mb-2 text-sm text-slate-500 dark:text-slate-400">
                                        {t("Facts about the software and this machine. No project names, topics, notes or anything you have studied.")}
                                    </p>
                                    {/* WRAPS, rather than scrolling sideways. The browser
                                        user-agent string is one long line and `overflow-auto`
                                        put a horizontal scrollbar under a block the reader is
                                        being asked to CHECK before submitting — half of it off
                                        screen. These are key: value facts, not code: a line
                                        break changes nothing, so wrapping is the better
                                        reading. */}
                                    <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-slate-100 p-3 font-mono text-xs leading-relaxed text-slate-700 dark:bg-slate-900 dark:text-slate-300">
{block || t("Version information is not available.")}
                                    </pre>
                                </div>
                            )}
                        </div>

                        <div className="space-y-3 border-t border-slate-200 p-4 dark:border-slate-700">
                            {shortened.length > 0 && (
                                <p className="flex items-start gap-2 rounded-lg bg-slate-100 p-3 text-sm text-slate-700 dark:bg-slate-900/60 dark:text-slate-200">
                                    <Info className="mt-0.5 h-4 w-4 shrink-0 text-accent-fg" aria-hidden="true" />
                                    {t("Too long for one link, so {{fields}} will arrive cut short. Press Copy report and paste the rest on GitHub.", {
                                        fields: shortened.map(s => `“${s.id === 'title' ? t("Title") : t(s.label)}”`).join(', '),
                                    })}
                                </p>
                            )}
                            <div className="flex flex-wrap items-center gap-2">
                                <p className="min-w-[12rem] flex-1 text-sm text-slate-500 dark:text-slate-400">
                                    {t("Reports on GitHub are public: leave out anything private.")}
                                </p>
                                <div className="ml-auto flex gap-2">
                                    <Button
                                        onClick={copy}
                                        icon={copied
                                            ? <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                                            : <Copy className="h-4 w-4" aria-hidden="true" />}
                                    >
                                        {copied ? t("Copied") : t("Copy report")}
                                    </Button>
                                    <ButtonLink
                                        href={url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        onClick={opened}
                                        variant="primary"
                                        icon={<ExternalLink className="h-4 w-4" aria-hidden="true" />}
                                    >
                                        {t("Continue on GitHub")}
                                    </ButtonLink>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>,
                document.body,
            )}
        </>
    );
}
