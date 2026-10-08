import { useEffect, useRef } from 'react';
import { AlertCircle, EyeOff, FileSpreadsheet, FileText, ImageIcon, Presentation, RotateCcw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { api } from '../../api';
import { Button, IconButton } from '../ui/Button';
import { useNumberFormat } from '../../hooks/useNumberFormat';
import type { ComposerFile, Refusal } from '../../hooks/useComposerAttachments';
import { ATTACH_MAX_BYTES, ATTACH_MAX_FILES, shortName, sizeLabel } from '../../utils/attachments';

/** The icon a file's card carries, by what its bytes turned out to be (or its name, before then). */
export function FileGlyph({ fileType, name, className = 'w-5 h-5' }: { fileType?: string | null; name?: string; className?: string }) {
    const t = (fileType || (name?.split('.').pop() ?? '')).toLowerCase();
    if (t === 'xlsx' || t === 'csv' || t === 'xls') return <FileSpreadsheet className={className} aria-hidden="true" />;
    if (t === 'pptx' || t === 'ppt') return <Presentation className={className} aria-hidden="true" />;
    if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif'].includes(t)) return <ImageIcon className={className} aria-hidden="true" />;
    return <FileText className={className} aria-hidden="true" />;
}

/** "PDF · 3 pages · 1.2 MB" — what a file card says under its name. */
export function fileFacts(t: TFunction, num: (n: number) => string, f: { fileType?: string | null; pages?: number | null; size: number; name: string }): string {
    const kind = (f.fileType || f.name.split('.').pop() || '').toLowerCase();
    const word = ({ pdf: 'PDF', docx: 'Word', xlsx: 'Excel', pptx: 'PowerPoint', text: t("Text") } as Record<string, string>)[kind] ?? kind;
    const pages = f.pages ? (kind === 'pptx' ? t("{{count}} slides", { count: f.pages }) : t("{{count}} pages", { count: f.pages })) : null;
    return [word, pages, sizeLabel(f.size, num)].filter(Boolean).join(' · ');
}

/** A ring that fills as the upload goes, over the thumbnail or beside the name. */
function ProgressRing({ value, className = 'w-6 h-6' }: { value: number; className?: string }) {
    const r = 9;
    const c = 2 * Math.PI * r;
    return (
        <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
            <circle cx="12" cy="12" r={r} fill="none" stroke="currentColor" strokeOpacity="0.3" strokeWidth="3" />
            <circle cx="12" cy="12" r={r} fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"
                strokeDasharray={c} strokeDashoffset={c * (1 - Math.max(0.04, Math.min(1, value)))}
                transform="rotate(-90 12 12)" className="transition-[stroke-dashoffset] duration-200" />
        </svg>
    );
}

/** Why one file was not taken, after its name — in words, with what to do instead. */
function refusalReason(t: TFunction, num: (n: number) => string, r: Refusal): string {
    switch (r.reason) {
        case 'too_large': return t("Larger than {{size}} MB. Try a smaller file, or only the part you need.", { size: num(ATTACH_MAX_BYTES / 1024 / 1024) });
        case 'too_many': return t("One message holds at most {{count}} files.", { count: ATTACH_MAX_FILES });
        case 'heic':
        case 'heic_unreadable': return t("An iPhone photo format that cannot be opened here. Attach a screenshot of it instead.");
        case 'empty': return t("The file is empty.");
        case 'duplicate': return t("Already attached.");
        default: return t("Videos, sound, archives and programs cannot be read here.");
    }
}

/**
 * The files waiting in the composer, as chips above the text — a picture as its
 * thumbnail, anything else as a card with its name and what it is — each with
 * its ✕. They wrap into rows (a strip that scrolls sideways hid the first file
 * behind the edge), and the box scrolls once it holds more than two rows.
 *
 * Under them, one line per file that needs a word: refused before uploading
 * (with why, and what to do instead), failed (with the server's reason; Try
 * again is on its chip), still uploading (Send waits for it), and a picture the
 * chat model cannot see.
 */
export default function AttachmentChips({ files, refusals, unseen, onRemove, onRetry, onDismissRefusals, onOpenSettings }: {
    files: ComposerFile[];
    refusals: Refusal[];
    /** A photo is ready for a model that cannot see pictures. */
    unseen: boolean;
    /** Where a model that can see is chosen. */
    onOpenSettings: () => void;
    onRemove: (key: string) => void;
    onRetry: (key: string) => void;
    onDismissRefusals: () => void;
}) {
    const { t } = useTranslation();
    const num = useNumberFormat();
    // A file just added is the one to see — its upload, or why it failed — so
    // the box scrolls ITSELF to its end (never the page: utils/scrollWithin.ts).
    const listRef = useRef<HTMLUListElement>(null);
    const count = files.length;
    const lastCount = useRef(count);
    useEffect(() => {
        const list = listRef.current;
        if (list && count > lastCount.current) list.scrollTop = list.scrollHeight;
        lastCount.current = count;
    }, [count]);
    const uploading = files.filter(f => f.state === 'preparing' || f.state === 'uploading').length;
    const failed = files.filter(f => f.state === 'failed');
    if (!files.length && !refusals.length) return null;
    return (
        <div className="space-y-1.5">
            {files.length > 0 && (
                <ul ref={listRef} className="flex flex-wrap gap-2 max-h-[9.5rem] overflow-y-auto overscroll-contain pt-1.5 pr-1.5 [scrollbar-width:thin]" aria-label={t("Attached files")}>
                    {files.map(f => {
                        const busy = f.state === 'preparing' || f.state === 'uploading';
                        const isFailed = f.state === 'failed';
                        const picture = f.preview || (f.kind === 'image' && f.server ? api.attachmentFileUrl(f.server.id) : null);
                        const status = busy
                            ? (f.state === 'preparing' ? t("Preparing…") : t("Uploading {{percent}}%", { percent: num(Math.round(f.progress * 100)) }))
                            : isFailed ? t("Upload failed") : null;
                        if (picture && !isFailed) {
                            return (
                                <li key={f.key} className="relative shrink-0" title={status ? `${f.name} — ${status}` : f.name}>
                                    <img src={picture} alt={f.name} className="block w-16 h-16 rounded-xl object-cover border border-slate-200 dark:border-slate-600 bg-slate-100 dark:bg-slate-700" />
                                    {busy && (
                                        <span className="absolute inset-0 flex items-center justify-center rounded-xl bg-black/45 text-white" role="status" aria-label={status ?? undefined}>
                                            <ProgressRing value={f.state === 'preparing' ? 0.04 : f.progress} />
                                        </span>
                                    )}
                                    <button
                                        type="button"
                                        data-chip-remove
                                        onClick={() => onRemove(f.key)}
                                        aria-label={t("Remove {{name}}", { name: f.name })}
                                        title={t("Remove {{name}}", { name: f.name })}
                                        className="absolute -top-1.5 -right-1.5 flex items-center justify-center w-6 h-6 rounded-full bg-slate-800 text-white ring-2 ring-white dark:bg-slate-100 dark:text-slate-900 dark:ring-slate-800 can-hover:hover:bg-slate-700 dark:can-hover:hover:bg-white before:absolute before:-inset-2.5 before:content-[''] outline-none focus-visible:ring-accent"
                                    >
                                        <X className="w-3.5 h-3.5" aria-hidden="true" />
                                    </button>
                                </li>
                            );
                        }
                        return (
                            <li
                                key={f.key}
                                title={f.name}
                                className={`flex items-center gap-2 max-w-xs h-16 pl-2 pr-1 rounded-xl border bg-white dark:bg-slate-800 ${isFailed
                                    ? 'border-red-400 dark:border-red-500'
                                    : 'border-slate-200 dark:border-slate-600'}`}
                            >
                                <span className={`flex items-center justify-center w-10 h-10 shrink-0 rounded-lg ${isFailed
                                    ? 'bg-red-50 text-red-600 dark:bg-red-950/40 dark:text-red-300'
                                    : 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-200'}`}>
                                    {busy ? <ProgressRing value={f.state === 'preparing' ? 0.04 : f.progress} className="w-6 h-6 text-accent-fg" />
                                        : isFailed ? <AlertCircle className="w-5 h-5" aria-hidden="true" />
                                            : <FileGlyph fileType={f.server?.fileType} name={f.name} />}
                                </span>
                                <span className="min-w-0 flex-1">
                                    <span className="block truncate text-sm font-medium text-slate-800 dark:text-slate-100">{shortName(f.name)}</span>
                                    <span
                                        className={`block truncate text-xs ${isFailed ? 'text-red-700 dark:text-red-300' : 'text-slate-500 dark:text-slate-400'}`}
                                        role={busy || isFailed ? 'status' : undefined}
                                    >
                                        {status ?? fileFacts(t, num, { fileType: f.server?.fileType, pages: f.server?.pages, size: f.server?.size ?? f.size, name: f.name })}
                                    </span>
                                </span>
                                {isFailed && f.file && (
                                    <IconButton size="sm" label={t("Try again: {{name}}", { name: f.name })} icon={<RotateCcw className="w-4 h-4" />} onClick={() => onRetry(f.key)} />
                                )}
                                <IconButton size="sm" label={t("Remove {{name}}", { name: f.name })} icon={<X className="w-4 h-4" />} onClick={() => onRemove(f.key)} />
                            </li>
                        );
                    })}
                </ul>
            )}
            {uploading > 0 && (
                <p className="text-xs text-slate-500 dark:text-slate-400" role="status">
                    {t("Uploading {{count}} files… Send waits until they are done.", { count: uploading })}
                </p>
            )}
            {unseen && (
                <div className="flex items-start gap-1.5 text-xs leading-5 text-slate-600 dark:text-slate-300">
                    <EyeOff className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
                    <div className="min-w-0">
                        <p>{t("The AI model set up here cannot see pictures, so it will get only the photo's name. A model that can see is chosen in Settings → AI & Models.")}</p>
                        <Button size="sm" variant="quiet" className="-ml-3" onClick={onOpenSettings}>{t("Open AI settings")}</Button>
                    </div>
                </div>
            )}
            {failed.length > 0 && (
                <ul className="space-y-1 rounded-lg bg-red-50 dark:bg-red-950/40 px-2.5 py-1.5 text-xs leading-5 text-red-800 dark:text-red-100" role="alert">
                    {failed.map(f => (
                        <li key={f.key} className="break-words">
                            <strong className="font-semibold">{f.name}</strong>: {f.error || t("Upload failed")} {f.file ? t("Try again, or remove it to send without it.") : t("Remove it to send without it.")}
                        </li>
                    ))}
                </ul>
            )}
            {refusals.length > 0 && (
                <div className="flex items-start gap-2 rounded-lg bg-amber-50 dark:bg-amber-950/40 px-2.5 py-1.5 text-xs leading-5 text-amber-900 dark:text-amber-100" role="alert">
                    <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                        {/* A heading only over a list: over one line it is a label for nothing. */}
                        {refusals.length > 1 && <p className="font-semibold">{t("Not added:")}</p>}
                        <ul className="space-y-1">
                            {refusals.slice(0, 5).map((r, i) => (
                                <li key={i} className="break-words"><strong className="font-semibold">{r.name}</strong>: {refusalReason(t, num, r)}</li>
                            ))}
                            {refusals.length > 5 && <li>{t("…and {{count}} more files not added.", { count: refusals.length - 5 })}</li>}
                        </ul>
                    </div>
                    <IconButton size="sm" label={t("Dismiss")} icon={<X className="w-4 h-4" />} onClick={onDismissRefusals} className="-my-1 -mr-1" />
                </div>
            )}
        </div>
    );
}
