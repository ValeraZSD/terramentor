import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { onActivateKey } from '../utils/a11y';
import { useTapGuard } from '../hooks/useTapGuard';
import { MOD_KEY, usePhysicalKeyboard, usePointerVerb } from '../utils/platform';
import Markdown from './Markdown';
import {
    X, Check, PenLine, FileText,
    Lock, Globe, type LucideIcon
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface MarkdownNotesProps {
    value: string;
    onChange: (value: string) => void;
    onSave: (value: string) => void;
    placeholder?: string;
    /** Field name shown in the header ("Notes", "Overview", "Material"…).
     *  Already translated by the caller — this component never authors it. */
    label: string;
    /** Header icon; defaults to the notes page icon. */
    icon?: LucideIcon;
    /** Public/private marker so the learner knows what leaves the device on export. */
    badge?: 'private' | 'public';
    /** The node this text belongs to — context for a ```drill and for a repair. */
    nodeId?: number;
    /** Which field this is (`overview`, `material`, `notes`), for a feedback report. */
    surface?: string;
}

type ViewMode = 'preview' | 'edit';

export default function MarkdownNotes({ value, onChange, onSave, placeholder, label, icon: Icon = FileText, badge, nodeId, surface }: MarkdownNotesProps) {
    const { t: tr } = useTranslation();
    const lowerLabel = label.toLowerCase();
    const BadgeChip = badge && (
        <span
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-normal normal-case tracking-normal text-[10px] ${badge === 'private'
                ? 'bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400'
                : 'bg-accent/10 text-accent-fg'
                }`}
            title={badge === 'private' ? tr("Private — never exported unless you opt in; the tutor reads it when it answers about this topic") : tr("Shared — included when you export or publish this project")}
        >
            {badge === 'private' ? <Lock className="w-2.5 h-2.5" /> : <Globe className="w-2.5 h-2.5" />}
            {badge === 'private' ? tr("Private") : tr("Shared")}
        </span>
    );
    const [mode, setMode] = useState<ViewMode>('preview');
    const [localValue, setLocalValue] = useState(value);
    const [justSaved, setJustSaved] = useState(false);
    const [isDirty, setIsDirty] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const hasKeyboard = usePhysicalKeyboard();
    const pointerVerb = usePointerVerb();
    // The handler takes metaKey OR ctrlKey; only the label was platform-bound.
    const saveCombo = `${MOD_KEY}+Enter`;

    // Sync when the external value changes (node selection, etc.)
    useEffect(() => {
        setLocalValue(value);
        setIsDirty(false);
    }, [value]);

    // Fade out "Saved" badge
    useEffect(() => {
        if (justSaved) {
            const timer = setTimeout(() => setJustSaved(false), 2200);
            return () => clearTimeout(timer);
        }
    }, [justSaved]);

    // Auto-resize textarea
    const adjustHeight = useCallback(() => {
        const ta = textareaRef.current;
        if (!ta) return;
        ta.style.height = 'auto';
        ta.style.height = Math.max(200, ta.scrollHeight) + 'px';
    }, []);

    useEffect(() => {
        if (mode === 'edit') adjustHeight();
    }, [mode, localValue, adjustHeight]);

    useEffect(() => {
        const textarea = textareaRef.current;
        if (!textarea || mode !== 'edit') return;

        const handleNativeKeydown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.stopPropagation();        // stop bubble to document
                doCancel();
            }
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.stopPropagation();
                doSave();
            }
        };

        textarea.addEventListener('keydown', handleNativeKeydown);
        return () => textarea.removeEventListener('keydown', handleNativeKeydown);
    }, [mode, localValue, value]); // include deps that doCancel/doSave close over

    const enterEdit = useCallback(() => {
        setLocalValue(value);
        setIsDirty(false);
        setMode('edit');
        requestAnimationFrame(() => textareaRef.current?.focus());
    }, [value]);

    const doSave = useCallback(() => {
        if (!isDirty && localValue === value) {
            setMode('preview');
            return;
        }
        onSave(localValue);
        setIsDirty(false);
        setJustSaved(true);
        setMode('preview');
    }, [localValue, value, isDirty, onSave]);

    const doCancel = useCallback(() => {
        setLocalValue(value);
        setIsDirty(false);
        setMode('preview');
    }, [value]);

    // React onKeyDown is now a BACKUP — the native listener above
    // handles the actual shortcut + propagation stopping.
    // We keep this for Tab indentation only.
    const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Tab') {
            e.preventDefault();
            const ta = e.currentTarget;
            const start = ta.selectionStart;
            const end = ta.selectionEnd;
            const next = localValue.substring(0, start) + '  ' + localValue.substring(end);
            setLocalValue(next);
            setIsDirty(true);
            requestAnimationFrame(() => {
                ta.selectionStart = ta.selectionEnd = start + 2;
            });
        }
    }, [localValue]);

    const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const next = e.target.value;
        setLocalValue(next);
        setIsDirty(next !== value);
    }, [value]);

    const wordCount = useMemo(() => {
        const t = localValue.trim();
        return t ? t.split(/\s+/).length : 0;
    }, [localValue]);

    const hasContent = localValue.trim().length > 0;

    // The preview is click-to-edit, which means the END of a text-selection drag
    // inside it is also a click — so highlighting a formula out of an Overview
    // swapped the rendered markdown for a raw textarea and threw the selection
    // away. `useTapGuard` is the shared rule: a click only counts as a tap if it
    // was pressed and released in roughly the same place with nothing selected.
    // (The keyboard path is unaffected — Enter/Space still enter edit directly.)
    const previewTap = useTapGuard(enterEdit);

    /**
     * A visual inside this field was fixed with AI — write the corrected spec
     * back into the field itself, once. Without this the Overview (which IS
     * AI-authored) kept its broken spec and asked the model again on every
     * load: the exact failure the assistant had before it gained a write-back.
     *
     * Only in preview mode: while the textarea is open the learner owns the
     * text, and a background repair must never edit under their cursor.
     */
    const handleRepaired = useCallback((originalCode: string, repairedCode: string) => {
        if (mode !== 'preview' || !localValue.includes(originalCode)) return;
        const next = localValue.split(originalCode).join(repairedCode);
        setLocalValue(next);
        onChange(next);
        onSave(next);
    }, [mode, localValue, onChange, onSave]);

    // PREVIEW MODE

    if (mode === 'preview') {
        return (
            <div className="group/notes relative">
                <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                        <Icon className="w-3 h-3" />
                        {label}
                        {BadgeChip}
                        {hasContent && (
                            <span className="font-normal normal-case tracking-normal text-slate-500 dark:text-slate-400">
                                · {wordCount} {wordCount === 1 ? tr("word") : tr("words")}
                            </span>
                        )}
                    </span>
                    <div className="flex items-center gap-1.5">
                        {justSaved && (
                            <span className="flex items-center gap-1 text-[11px] text-emerald-500 animate-fade-in">
                                <Check className="w-3 h-3" />
                                {tr("Saved")}
                            </span>
                        )}
                        <button
                            onClick={enterEdit}
                            className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium
                                       text-slate-400 hover:text-accent-fg
                                       hover:bg-accent/10 transition-colors"
                            title={tr("Edit {{lowerLabel}}", { lowerLabel })}
                        >
                            <PenLine className="w-3 h-3" />
                            {tr("Edit")}
                        </button>
                    </div>
                </div>

                {/* An editable field is RECESSED into the panel it sits on, in
                    both themes: slate-50 on the white panel, slate-900/40 on the
                    slate-800 one. The panel's own colour is no recess at all
                    (`bg-white` on white; 60% of slate-800 over slate-800
                    composites to exactly slate-800): one flat sheet in dark
                    mode, only the borders saying where a field begins. */}
                <div
                    {...previewTap}
                    onKeyDown={onActivateKey(enterEdit)}
                    role="button"
                    tabIndex={0}
                    aria-label={tr("Edit {{lowerLabel}}", { lowerLabel })}
                    className={`relative rounded-xl border transition-all duration-200 cursor-text overflow-hidden ${hasContent
                        ? 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/40 hover:border-accent/40 dark:hover:border-accent hover:shadow-sm'
                        : 'border-dashed border-slate-300 dark:border-slate-600 bg-slate-50/60 dark:bg-slate-900/25 hover:border-accent'
                        }`}
                >
                    {hasContent ? (
                        <>
                            <div className="p-4 max-h-[360px] overflow-y-auto overscroll-contain custom-scrollbar select-text">
                                <div className="prose prose-sm dark:prose-invert max-w-none prose-p:my-2 prose-headings:my-3 prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 prose-pre:my-2">
                                    <Markdown
                                        content={localValue}
                                        nodeId={nodeId}
                                        surface={surface}
                                        autoBuild={false}
                                        onRepaired={handleRepaired}
                                    />
                                </div>
                            </div>
                            {/* The edit hint is a STRIP UNDER the content, not a
                                floating pill over it. As an overlay it sat at 0.75
                                opacity on top of the last line of prose — two
                                layers of text through each other, so neither the
                                hint nor the sentence it covered was readable, and
                                on a touchscreen (no hover to dismiss it) that was
                                its permanent state. Outside the scroll box it can
                                never collide with what it is describing. */}
                            <div className="flex items-center justify-center gap-1 px-3 py-1.5 border-t border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-900/60 text-[11px] font-medium text-slate-500 dark:text-slate-400 select-none">
                                <PenLine className="w-3 h-3" aria-hidden="true" />
                                {tr("{{pointerVerb}} to edit", { pointerVerb })}
                            </div>
                        </>
                    ) : (
                        <div className="p-8 flex flex-col items-center gap-2 text-slate-500 dark:text-slate-400">
                            <PenLine className="w-8 h-8 opacity-40" />
                            <p className="text-sm font-medium">{placeholder || tr("{{pointerVerb}} to add notes", { pointerVerb })}</p>
                            <p className="text-xs opacity-60">{tr("Supports Markdown")}{hasKeyboard && <span> · <kbd className="px-1 py-0.5 bg-slate-200 dark:bg-slate-700 rounded text-[10px]">{saveCombo}</kbd> {tr("to save")}</span>}</p>
                        </div>
                    )}
                </div>
            </div>
        );
    }

    // EDIT MODE

    return (
        <div className="relative border-2 border-accent/40 dark:border-accent rounded-xl overflow-hidden bg-white dark:bg-slate-800">
            {/* Toolbar */}
            <div className="flex items-center justify-between px-3 py-2 bg-accent/10 border-b border-accent/30">
                <div className="flex items-center gap-2">
                    <PenLine className="w-3.5 h-3.5 text-accent-fg" />
                    <span className="text-xs font-medium text-accent-fg">{tr("Editing {{lowerLabel}}", { lowerLabel })}</span>
                    <span className="text-xs text-slate-500 dark:text-slate-400">· {wordCount} {wordCount === 1 ? tr("word") : tr("words")}</span>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={doCancel}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 border border-slate-300 dark:border-slate-600 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                        title={hasKeyboard ? tr("Cancel editing (Esc)") : tr("Cancel editing")}
                    >
                        <X className="w-3.5 h-3.5" />
                        {tr("Cancel")}
                    </button>
                    <button
                        onClick={doSave}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-accent text-white rounded-lg hover:bg-accent/90 transition-colors"
                        title={hasKeyboard ? tr("Save notes ({{saveCombo}})", { saveCombo }) : tr("Save notes")}
                    >
                        <Check className="w-3.5 h-3.5" />
                        {tr("Save")}
                    </button>
                </div>
            </div>

            {/* Textarea */}
            <textarea
                ref={textareaRef}
                value={localValue}
                onChange={handleChange}
                onKeyDown={handleKeyDown}
                placeholder={placeholder || tr("Write your {{lowerLabel}} here…", { lowerLabel })}
                rows={8}
                className="w-full px-4 py-3 bg-transparent text-sm text-slate-800 dark:text-slate-200 placeholder:text-slate-400 dark:placeholder:text-slate-500 resize-none focus:outline-none min-h-[200px]"
                autoFocus
            />

            {hasKeyboard && (
                <div className="px-3 py-1.5 bg-slate-50 dark:bg-slate-900/50 border-t border-slate-200 dark:border-slate-700 text-xs text-slate-500 dark:text-slate-400">
                    <kbd className="px-1.5 py-0.5 bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded text-[10px] font-mono">Esc</kbd> {tr("cancel ·")}{' '}<kbd className="px-1.5 py-0.5 bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded text-[10px] font-mono">{saveCombo}</kbd> {tr("save ·")}{' '}<kbd className="px-1.5 py-0.5 bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded text-[10px] font-mono">Tab</kbd> {tr("indent")}
                </div>
            )}
        </div>
    );
}