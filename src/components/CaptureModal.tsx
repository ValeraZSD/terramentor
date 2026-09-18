import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { FileText, Image as ImageIcon, Inbox, Link2, Paperclip, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import { Button, IconButton } from './ui/Button';
import { TextArea, TextInput } from './ui/Field';
import { useAutoGrow } from '../hooks/useAutoGrow';
import { useTapGuard } from '../hooks/useTapGuard';
import { MOD_KEY, usePhysicalKeyboard } from '../utils/platform';

interface Props {
    open: boolean;
    onClose: () => void;
}

const looksLikeUrl = (s: string) => /^https?:\/\/\S+$/i.test(s.trim());
const MAX_CAPTURE_FILES = 10;
const stripExt = (name: string) => name.replace(/\.[^./\\]+$/, '');
const isImage = (f: File) => f.type.startsWith('image/');

// Runs after the modal has already closed (Capture is meant to be instant),
// so it takes what it needs as arguments rather than reading component state.
// Order matters: the files must be attached to the node before enrichment is
// told to start, or the background task reads an empty node — see the
// `hasFiles` comment on POST /api/capture.
async function uploadAndEnrich(
    nodeId: number,
    projectId: number,
    url: string,
    files: File[],
    addToast: (type: 'success' | 'error' | 'info', message: string, details?: string) => void,
) {
    try {
        await api.uploadDocumentFiles(files, { nodeId, projectId });
    } catch (e: any) {
        addToast('error', i18n.t("Some files failed to attach"), e.message);
    }
    try {
        const { taskId } = await api.enrichCapture(nodeId, url);
        addToast(
            'success',
            i18n.t("Captured to your Inbox"),
            taskId ? i18n.t("Writing an overview and flashcards now — watch the task bar.") : i18n.t("Saved as-is (no AI model selected)."),
        );
    } catch {
        // The files are already attached either way — a failed enrich kickoff
        // costs polish, not the thing the learner wanted to keep.
    }
}

/**
 * Ad-hoc capture: paste something worth keeping, get it back as a studiable
 * topic.
 *
 * The whole point is that it costs nothing to use — one field, no project to
 * choose, no schedule to set. It lands in the permanent unscheduled Inbox
 * project, where the feed gives it a standing slot (server/feed.js) and SRS
 * picks up its flashcards the same day, because a capture is just a node and
 * every downstream system already speaks node.
 *
 * Saving is deliberately not gated on the AI: the server writes the node before
 * any model runs and enriches it in the background, so this dialog closes
 * immediately and a model that is slow, cold or switched off costs polish
 * rather than the thing the learner wanted to keep.
 *
 * The three ways something arrives here are the three ways a person copies: a
 * paste into the box, a link, and a file — so the box takes a pasted SCREENSHOT
 * as an attachment, the whole dialog is a drop target, and the attach control is
 * a button rather than a line of text pretending to be one.
 */
export default function CaptureModal({ open, onClose }: Props) {
    const { t } = useTranslation();
    const addToast = useStore(s => s.addToast);
    const hasKeyboard = usePhysicalKeyboard();

    const [text, setText] = useState('');
    const [url, setUrl] = useState('');
    const [title, setTitle] = useState('');
    const [files, setFiles] = useState<File[]>([]);
    const [saving, setSaving] = useState(false);
    const [dragging, setDragging] = useState(false);
    // A drag over a CHILD fires `dragleave` on the parent, so a boolean alone
    // makes the highlight flicker across every element under the pointer.
    const dragDepth = useRef(0);
    // The box starts at a few lines and grows with what was pasted, up to a
    // ceiling — a fixed `rows` is a guess, and it was seven empty lines for the
    // one-sentence capture and too few for the article.
    const textRef = useAutoGrow(text, { rows: 12 });
    const fileInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (!open) return;
        setText(''); setUrl(''); setTitle(''); setFiles([]); setSaving(false);
        dragDepth.current = 0; setDragging(false);
        // Focus after paint so the dialog animation doesn't eat the focus.
        const id = requestAnimationFrame(() => textRef.current?.focus());
        return () => cancelAnimationFrame(id);
    }, [open, textRef]);

    // The page behind must not scroll under the dialog, exactly as `Modal` does.
    useEffect(() => {
        if (!open) return;
        document.body.style.overflow = 'hidden';
        return () => { document.body.style.overflow = ''; };
    }, [open]);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    // Thumbnails, so the learner can see WHICH screenshot they just pasted.
    // Revoked as a set: the effect's cleanup runs against the previous list.
    const previews = useMemo(
        () => files.map(f => (isImage(f) ? URL.createObjectURL(f) : null)),
        [files],
    );
    useEffect(() => () => { previews.forEach(u => u && URL.revokeObjectURL(u)); }, [previews]);

    // Pasting a bare URL into the text box is the single most common capture,
    // so move it to the URL field rather than making the learner aim.
    const handleTextChange = (value: string) => {
        if (!url && looksLikeUrl(value)) {
            setUrl(value.trim());
            setText('');
            return;
        }
        setText(value);
    };

    // Documents (PDF/DOCX/XLSX/PPTX/text) go through the same vault pipeline
    // as the per-project Vault; photos get a dedicated vision pass in
    // enrichCapture (server/capture.js) — one that, for a photo with several
    // distinct notable subjects, writes one topic per subject instead of a
    // single blended overview.
    //
    // The `Array.from` has to happen HERE, not inside the updater: a FileList
    // is a LIVE view of the input, the picker's handler clears `value` so the
    // same file can be chosen twice, and a `setFiles(prev => …)` updater runs
    // after the handler returns — by which time the list it was going to read
    // is empty. Every file picked through the button was silently dropped.
    const addFiles = (list: FileList | File[] | null) => {
        if (!list || list.length === 0) return;
        const picked = Array.from(list);
        setFiles(prev => {
            const existing = new Set(prev.map(f => `${f.name}:${f.size}`));
            const fresh = picked.filter(f => !existing.has(`${f.name}:${f.size}`));
            return [...prev, ...fresh].slice(0, MAX_CAPTURE_FILES);
        });
    };
    const removeFile = (index: number) => setFiles(prev => prev.filter((_, i) => i !== index));

    // A screenshot on the clipboard is a capture, not text: Windows and macOS
    // both deliver it as a file on the paste event, and without this it pasted
    // as nothing at all.
    const handlePaste = (e: React.ClipboardEvent) => {
        const pasted = Array.from(e.clipboardData?.files ?? []);
        if (!pasted.length) return;
        e.preventDefault();
        addFiles(pasted);
    };

    // The whole overlay is the drop target, backdrop included: a file dropped
    // on a page that is not expecting it makes the browser NAVIGATE to it, and
    // aiming at a dialog is exactly where that miss happens.
    const dragProps = {
        onDragEnter: (e: React.DragEvent) => {
            if (!e.dataTransfer?.types?.includes('Files')) return;
            dragDepth.current += 1;
            setDragging(true);
        },
        onDragOver: (e: React.DragEvent) => {
            if (!e.dataTransfer?.types?.includes('Files')) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
        },
        onDragLeave: () => {
            dragDepth.current = Math.max(0, dragDepth.current - 1);
            if (dragDepth.current === 0) setDragging(false);
        },
        onDrop: (e: React.DragEvent) => {
            e.preventDefault();
            dragDepth.current = 0;
            setDragging(false);
            addFiles(e.dataTransfer?.files ?? null);
        },
    };

    const save = async () => {
        const body = text.trim();
        const link = url.trim();
        const hasFiles = files.length > 0;
        if (saving || (!body && !link && !hasFiles)) return;
        setSaving(true);
        // No title and no pasted text/link, but files were attached — fall
        // back to the first filename so the capture always has a name;
        // enrichCapture may still rename it once it has read the file(s).
        const finalTitle = title.trim() || (hasFiles && !body && !link ? stripExt(files[0].name) : title.trim());
        try {
            const res = await api.capture({ text: body, url: link, title: finalTitle, hasFiles });
            onClose();
            if (hasFiles) {
                addToast(
                    'success',
                    t("Captured to your Inbox"),
                    files.length === 1 ? t("Attaching {{name}}…", { name: files[0].name }) : t("Attaching {{count}} files…", { count: files.length }),
                );
                // Fire-and-forget: the dialog is already closed, this finishes
                // in the background exactly like text enrichment does.
                uploadAndEnrich(res.nodeId, res.projectId, link, files, addToast);
            } else {
                addToast(
                    'success',
                    t("Captured to your Inbox"),
                    res.taskId
                        ? t("Writing an overview and flashcards now — watch the task bar.")
                        : t("Saved as-is (no AI model selected)."),
                );
            }
            // Deliberately does NOT navigate. Capture has to be cheap enough to
            // use mid-lesson; yanking the learner into the Inbox would make it
            // an interruption, which is exactly what it must not be. The Inbox
            // project and the task chip are both one glance away.
        } catch (e: any) {
            addToast('error', t("Could not save the capture"), e.message);
            setSaving(false);
        }
    };

    // Dismiss on a backdrop TAP, not on any click that happens to land there —
    // a selection dragged out of the box very often lifts over the backdrop,
    // and that threw the capture away mid-edit.
    const backdrop = useTapGuard(onClose, true);

    if (!open) return null;

    const canSave = !!(text.trim() || url.trim() || files.length > 0);
    const full = files.length >= MAX_CAPTURE_FILES;

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-black/60 dark:bg-black/80"
            {...backdrop}
            {...dragProps}
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-label={t("Capture something")}
                onKeyDown={e => {
                    // Save from anywhere in the dialog, including the box being
                    // typed into — the reason Capture exists is not to be a stop.
                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); save(); }
                }}
                /* A COLUMN, not a scrolling block: the header and the footer are
                   fixed and only the middle scrolls, so Save is on screen at any
                   UI scale. A whole-card scroll puts Save ~200px below the
                   bottom of a 375x812 phone at 160% (measured), with nothing
                   able to reach it. */
                className={`flex flex-col w-full max-w-xl max-h-[85vh] max-h-[85dvh] bg-white dark:bg-slate-800 rounded-2xl shadow-2xl transition-colors ${
                    dragging
                        ? 'border-2 border-dashed border-accent'
                        : 'border border-slate-200 dark:border-slate-700'
                }`}
            >
                {/* Title and close only. A sentence in this column, between a
                    fixed-width icon and a fixed-width close button, has ~186px
                    at 160% UI scale on a 390px phone and wraps onto SEVEN
                    lines, pushing the scrolling part of the dialog down to two
                    visible lines of text. It says
                    the same thing at the top of the body with the full width. */}
                <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-slate-200 dark:border-slate-700 shrink-0">
                    <div className="flex items-center gap-3 min-w-0">
                        <span className="p-2 rounded-lg bg-accent/10 shrink-0">
                            <Inbox className="w-5 h-5 text-accent-fg" aria-hidden="true" />
                        </span>
                        <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100 truncate">{t("Capture")}</h2>
                    </div>
                    <IconButton size="sm" label={t("Close")} icon={<X className="w-5 h-5" />} onClick={onClose} />
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-3">
                    <p className="text-sm text-slate-500 dark:text-slate-400">
                        {t("Keep something you just read — it joins your feed and reviews.")}
                    </p>

                    <TextArea
                        ref={textRef}
                        value={text}
                        onChange={e => handleTextChange(e.target.value)}
                        onPaste={handlePaste}
                        placeholder={t("Paste what you want to keep…")}
                        aria-label={t("Paste what you want to keep…")}
                        className="min-h-[7rem] resize-none"
                    />

                    <TextInput
                        value={url}
                        onChange={e => setUrl(e.target.value)}
                        icon={<Link2 className="w-4 h-4" />}
                        placeholder={t("Source URL (optional — fetched if you leave the text empty)")}
                        aria-label={t("Source URL")}
                        inputMode="url"
                    />

                    <TextInput
                        value={title}
                        onChange={e => setTitle(e.target.value)}
                        placeholder={t("Title (optional — the AI names it otherwise)")}
                        aria-label={t("Title")}
                    />

                    <div className="pt-1">
                        <input
                            ref={fileInputRef}
                            type="file"
                            multiple
                            accept="image/*,.pdf,.docx,.xlsx,.pptx,.txt,.md"
                            className="sr-only"
                            tabIndex={-1}
                            onChange={e => { addFiles(e.target.files); e.target.value = ''; }}
                        />
                        <Button
                            variant="neutral"
                            onClick={() => fileInputRef.current?.click()}
                            disabled={full}
                            icon={<Paperclip className="w-4 h-4 shrink-0" aria-hidden="true" />}
                            trailing={files.length > 0
                                ? <span className="tabular-nums text-xs text-slate-500 dark:text-slate-400">{files.length}/{MAX_CAPTURE_FILES}</span>
                                : undefined}
                        >
                            {t("Attach a document or photo")}
                        </Button>

                        {files.length > 0 && (
                            <ul className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
                                {files.map((f, i) => (
                                    <li
                                        key={`${f.name}-${f.size}-${i}`}
                                        className="flex items-center gap-2 min-w-0 pl-2 pr-1 py-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/60"
                                    >
                                        {previews[i]
                                            ? <img src={previews[i] as string} alt="" className="w-8 h-8 rounded object-cover shrink-0" />
                                            : (
                                                <span className="flex items-center justify-center w-8 h-8 rounded bg-slate-200 dark:bg-slate-700 shrink-0">
                                                    {isImage(f)
                                                        ? <ImageIcon className="w-4 h-4 text-slate-500 dark:text-slate-400" aria-hidden="true" />
                                                        : <FileText className="w-4 h-4 text-slate-500 dark:text-slate-400" aria-hidden="true" />}
                                                </span>
                                            )}
                                        <span className="truncate min-w-0 flex-1 text-sm text-slate-700 dark:text-slate-200">{f.name}</span>
                                        <IconButton
                                            size="sm"
                                            label={t("Remove {{name}}", { name: f.name })}
                                            icon={<X className="w-4 h-4" />}
                                            onClick={() => removeFile(i)}
                                        />
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>

                    {/* What pressing Save does, next to the button that does it
                        — but INSIDE the scrolling part. In the fixed footer it
                        was three wrapped lines at 160% UI scale on a phone, and
                        a fixed footer's height is taken straight out of the part
                        that scrolls: the box being typed into was down to five
                        visible lines. Only the two controls are pinned now. */}
                    <p className="pt-1 text-sm text-slate-500 dark:text-slate-400">
                        {t("Saved instantly — the overview and flashcards follow in the background.")}
                    </p>
                </div>

                <div className="flex flex-wrap items-center justify-end gap-2 px-5 py-3 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/50 rounded-b-2xl shrink-0">
                    <Button variant="quiet" onClick={onClose}>{t("Cancel")}</Button>
                    <Button
                        variant="primary"
                        onClick={save}
                        disabled={!canSave}
                        busy={saving}
                        icon={<Inbox className="w-4 h-4 shrink-0" aria-hidden="true" />}
                        trailing={hasKeyboard
                            ? <kbd className="font-sans text-xs text-white/70">{MOD_KEY}+Enter</kbd>
                            : undefined}
                        /* Fills the rest of its row on a phone, where the pair
                           does not leave enough width to look placed rather
                           than left over. Natural width once the dialog is at
                           its full 576px. */
                        className="grow sm:grow-0"
                    >
                        {t("Save to Inbox")}
                    </Button>
                </div>
            </div>
        </div>
    );
}
